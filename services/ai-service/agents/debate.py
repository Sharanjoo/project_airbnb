"""Debate logic as pure functions (API doc §11): plan, challenges, answers, votes,
decision rule, final result. The Chair (chair.py) adds Kafka, MongoDB and time."""
from datetime import datetime

from app.envelope import utc_now_iso
from app.pool import PropertyPool
from app.store import ANALYSIS_AGENTS

from .harness import disagreement_score, vote_is_backed
from .scoring import RANKERS, Peers, failures, matching_score, ref, risk_level, risk_signals

MIN_AGENTS = 2
CHALLENGE_THRESHOLD = 0.5
SWITCH_MARGIN = 0.02
HIGH_RISK_PENALTY = 0.15
RISK_PRICE_MARGIN = 0.15  # rule 2: a High risk flag outweighs a price difference under 15%

# ------------------------------------------------------------------- plan
STEPS = [("Parse request", "parser"), ("Retrieve available properties", "chair"),
         ("Independent rankings", "matching, risk, fairness"), ("Identify disagreements", "chair"),
         ("Challenges and responses", "chair"), ("Verify availability again", "chair"),
         ("Prepare recommendation for approval", "chair")]
# status -> (steps done, step running)
PROGRESS = {"PLANNING": (0, 1), "ROUND_0": (2, 3), "ROUND_1": (3, 4), "ROUND_2": (4, 5), "DECIDING": (5, 6),
            "AWAITING_APPROVAL": (7, None)}


def make_plan(plan_id: str, trace_id: str) -> dict:
    return {"plan_id": plan_id, "trace_id": trace_id, "revisions": [], "steps": [
        {"step_no": i, "name": name, "agent": agent, "input": "request" if i == 1 else f"step {i - 1}",
         "expected_output": name.lower(), "depends_on": [i - 1] if i > 1 else [], "status": "pending",
         "started_at": None, "ended_at": None, "note": None} for i, (name, agent) in enumerate(STEPS, 1)]}


def advance_plan(plan: dict, status: str, note: str | None = None) -> dict:
    """The plan after the task moves to status. A failure stops the running step."""
    now = utc_now_iso()
    steps = [dict(s) for s in plan["steps"]]
    if status in ("FAILED", "TIMED_OUT"):
        for s in steps:
            if s["status"] == "running":
                s.update(status="stopped", ended_at=now, note=note)
    else:
        done, running = PROGRESS[status]
        for s in steps:
            if s["step_no"] <= done and s["status"] not in ("done", "skipped"):
                s.update(status="done", started_at=s["started_at"] or now, ended_at=now)
            elif s["step_no"] == running and s["status"] == "pending":
                s.update(status="running", started_at=now)
    return {**plan, "steps": steps}


def skip_step(plan: dict, step_no: int, note: str) -> dict:
    """The plan with one step marked as not carried out, and why."""
    now = utc_now_iso()
    return {**plan, "steps": [{**s, "status": "skipped", "ended_at": now, "note": note} if s["step_no"] == step_no else s
                              for s in plan["steps"]]}


# ---------------------------------------------------------------- round 1
def top3(opinion: dict) -> list[str]:
    return [i["property_id"] for i in opinion["ranked"][:3]]


def scores_by_property(opinions: dict[str, dict]) -> dict[str, dict[str, float]]:
    """property -> agent -> score. An agent that left a property out of its top 10
    counts as half of its lowest ranked score."""
    every = {i["property_id"] for o in opinions.values() for i in o["ranked"]}
    out = {}
    for pid in every:
        out[pid] = {a: next((i["score"] for i in o["ranked"] if i["property_id"] == pid),
                            round(o["ranked"][-1]["score"] / 2, 4)) for a, o in opinions.items()}
    return out


def mean(values) -> float:
    values = list(values)
    return sum(values) / len(values) if values else 0.0


def combined_ranking(scores: dict[str, dict[str, float]]) -> list[str]:
    return sorted(scores, key=lambda pid: (-mean(scores[pid].values()), pid))


def build_round1(task_id: str, opinions: dict[str, dict], req: dict, pool: PropertyPool) -> dict:
    """Everything the agents need to answer and vote. Deterministic."""
    agents = [a for a in ANALYSIS_AGENTS if a in opinions]
    picks = {a: opinions[a]["ranked"][0]["property_id"] for a in agents}
    disagreement = disagreement_score({a: top3(opinions[a]) for a in agents})
    scores = scores_by_property(opinions)
    option_ids = sorted(set(picks.values()), key=lambda p: (-mean(scores[p].values()), p))
    if len(option_ids) == 1:  # full agreement: keep a runner-up so there is something to compare
        option_ids += [p for p in combined_ranking(scores) if p not in option_ids][:1]
    peers = Peers(pool)

    def option(pid):
        p = pool.by_id[pid]
        return {"property_id": pid, "scores": scores[pid], "failures": failures(p, req),
                "risk_level": risk_level(risk_signals(p, peers.price_ratio(p))), "evidence_refs": [ref(p)]}

    options = [option(pid) for pid in option_ids]
    level = {o["property_id"]: o["risk_level"] for o in options}
    challenges = []

    def challenge(to, about, question, refs):
        challenges.append({"challenge_id": f"chl_{task_id}_{len(challenges) + 1}", "to_agent": to,
                           "about_property_id": about, "question": question, "evidence_refs": refs})

    if len(set(picks.values())) > 1 or disagreement >= CHALLENGE_THRESHOLD:
        for a in agents:
            mine = picks[a]
            rivals = [b for b in agents if picks[b] != mine]
            if rivals:
                rival = max(rivals, key=lambda b: scores[picks[b]][b] - scores[mine][b])
                other = picks[rival]
                reasons = "; ".join(opinions[rival]["ranked"][0]["reasons"][:2])
                challenge(a, mine, f"The {rival} agent puts {other} first ({reasons}). Why should {mine} rank higher?",
                          [f"property:{mine}", f"property:{other}"])
            elif level.get(mine) == "high":
                challenge(a, mine, f"{mine} carries a High risk flag. Why keep it first?", [f"property:{mine}"])
    # The Fairness auditor's own concern goes to another agent, through the Chair.
    concern = (opinions.get("fairness", {}).get("concerns") or [None])[0]
    if concern:
        to = next(a for a in agents if a != "fairness")
        about = concern["property_ids"][0] if concern.get("property_ids") else picks[to]
        challenge(to, about, f"Fairness concern ({concern['signal']}): {concern['detail']} How does your ranking account for it?",
                  concern["evidence_refs"])
    # ... and Fairness itself is always challenged (§11).
    if "fairness" in agents and not any(c["to_agent"] == "fairness" for c in challenges):
        challenge("fairness", picks["fairness"], f"All agents lean towards {picks['fairness']}. Does it depend on an inappropriate signal "
                  "such as popularity or price alone?", [f"property:{picks['fairness']}"])
    return {"round": 1, "challenges": challenges, "disagreement_score": disagreement, "voters": agents,
            "top_picks": picks, "options": options}


# ---------------------------------------------------------------- round 2
def answer_and_vote(agent: str, round1: dict, req: dict, pool: PropertyPool) -> dict:
    """Half own judgement, half the others', minus a penalty for High risk. Switching
    needs a clear margin, so an agent does not give up its pick over noise."""
    own = {i["property_id"]: i for i in RANKERS[agent](req, pool)["ranked"]}

    def value(o):
        others = [s for a, s in o["scores"].items() if a != agent]
        total = 0.5 * o["scores"][agent] + 0.5 * mean(others)
        return total - (HIGH_RISK_PENALTY if o["risk_level"] == "high" else 0)

    values = {o["property_id"]: round(value(o), 4) for o in round1["options"]}
    pick = round1["top_picks"][agent]
    best = max(values, key=lambda p: (values[p], p == pick))
    switch = best != pick and values[best] > values[pick] + SWITCH_MARGIN
    choice = best if switch else pick
    reason = (f"{best} is stronger once the other opinions and risk are counted ({values[best]:.2f} against {values[pick]:.2f})" if switch
              else f"{pick} still holds at {values[pick]:.2f} after weighing the other opinions")
    responses = []
    for c in round1["challenges"]:
        if c["to_agent"] != agent:
            continue
        about = c["about_property_id"]
        facts = "; ".join(own[about]["reasons"]) if about in own else "It is outside this agent's top 10"
        verdict = "I now prefer " + best if switch else "I keep " + pick
        responses.append({"challenge_id": c["challenge_id"], "answer": f"{facts}. {verdict}.", "evidence_refs": [f"property:{about}"]})
    return {"round": 2, "responses": responses,
            "vote": {"choice": "switch" if switch else "keep", "property_id": choice, "reason": reason,
                     "evidence_refs": [f"property:{choice}"]}}


# --------------------------------------------------------------- decision
def known_refs(opinions: dict[str, dict], round1: dict) -> set[str]:
    refs = {r for o in opinions.values() for i in o["ranked"] for r in i["evidence_refs"]}
    return refs | {r for c in round1["challenges"] for r in c["evidence_refs"]} | {r for o in round1["options"] for r in o["evidence_refs"]}


def count_votes(votes: dict[str, dict], refs: set[str], voters: list[str]) -> tuple[dict, dict[str, str], dict[str, str]]:
    """(keep/switch/abstain counts, agent -> property voted for, agent -> why it abstained)."""
    counts, ballots, abstained = {"keep": 0, "switch": 0, "abstain": 0}, {}, {}
    for agent in voters:
        vote = votes.get(agent)
        if not vote:
            abstained[agent] = "no valid vote before the deadline"
        elif vote["choice"] == "abstain":
            abstained[agent] = vote["reason"]
        elif not vote_is_backed(vote, refs):
            abstained[agent] = "the vote cited no stored evidence"
        else:
            counts[vote["choice"]] += 1
            ballots[agent] = vote["property_id"]
    counts["abstain"] = len(abstained)
    return counts, ballots, abstained


def decide(ballots: dict[str, str], round1: dict, opinions: dict[str, dict], req: dict, pool: PropertyPool) -> dict:
    """{property_id, mode, notes}. Majority is of everyone entitled to vote."""
    voters = round1["voters"]
    tally = {p: list(ballots.values()).count(p) for p in set(ballots.values())}
    leader = max(tally, key=lambda p: (tally[p], p), default=None)
    if leader and tally[leader] == len(voters):
        return {"property_id": leader, "mode": "consensus", "notes": []}
    if leader and tally[leader] * 2 > len(voters):
        return {"property_id": leader, "mode": "majority", "notes": []}

    notes = ["No strict majority, so the decision rule was applied."]
    left = list(round1["options"])
    valid = [o for o in left if not o["failures"]]  # rule 1
    if valid and len(valid) < len(left):
        notes.append("Rule 1: removed options that miss a stated requirement.")
        left = valid

    def price(o):
        return pool.by_id[o["property_id"]]["nightly_price"]

    safer = [o for o in left if o["risk_level"] != "high"]  # rule 2
    kept = [o for o in left if o["risk_level"] != "high"
            or not any(abs(price(s) - price(o)) < RISK_PRICE_MARGIN * max(price(o), price(s)) for s in safer)]
    if len(kept) < len(left):
        notes.append("Rule 2: a High risk flag outweighed a price difference under 15%.")
        left = kept
    ids = {o["property_id"] for o in left}
    drop = set()  # rule 3: only concerns about an option still in play are justified objections
    for c in opinions.get("fairness", {}).get("concerns", []):
        if ids & set(c.get("property_ids", [])):
            drop |= {"price_only": {"price"}, "popularity": {"rating"}, "new_listing": {"rating"}}.get(c["signal"], set())
    if drop:
        notes.append(f"Rule 3: a fairness objection removed {', '.join(sorted(drop))} from the matching score.")
    score = {i: matching_score(pool.by_id[i], req, pool, frozenset(drop)) for i in ids}  # rule 4
    notes.append("Rule 4: the highest matching score won.")
    return {"property_id": min(ids, key=lambda i: (-score[i], i)), "mode": "forced", "notes": notes}


# ----------------------------------------------------------------- result
def elapsed_ms(start: str | None, end: str | None) -> int | None:
    if not start or not end:
        return None
    a, b = (datetime.fromisoformat(t.replace("Z", "+00:00")) for t in (start, end))
    return max(0, round((b - a).total_seconds() * 1000))


def facts(p: dict, req: dict) -> list[str]:
    missed = failures(p, req)
    out = [f"Does not meet: {', '.join(missed)}" if missed else "Meets every stated requirement", f"${p['nightly_price']:g} per night"]
    out.append(f"{p['rating']:g} rating over {p['review_count']} reviews" if p["rating"] is not None else "No reviews yet")
    return out + [f"Sleeps {p['capacity']} in {p['city']}"]


def explain(result: dict, pool: PropertyPool) -> str:
    """Explanation skill: plain language built only from facts already in the result."""
    p = pool.by_id[result["recommended"]["property_id"]]
    how = {"consensus": "All voting agents agreed.", "majority": "Most voting agents agreed.",
           "forced": "The agents did not reach a majority, so the tie-break rules decided."}[result["decision"]["mode"]]
    text = f"We picked {p['title']} in {p['city']}. {'; '.join(result['rationale'])}. {how}"
    if result["rejected_alternative"]:
        text += f" The closest alternative was {pool.by_id[result['rejected_alternative']['property_id']]['title']}: {result['rejected_alternative']['why_lower']}."
    if result["risks"]:
        text += f" Worth knowing: {'; '.join(result['risks'])}."
    return text


def build_result(task: dict, opinions: dict[str, dict], votes: dict[str, dict], decision: dict, counts: dict, ballots: dict,
                 limitations: list[str], chosen: str, unavailable: list[str], availability: str, pool: PropertyPool, now: str) -> dict:
    """The §9 result body plus user_id, plan_id and debate details. Routing note: no
    top-level guest_id, host_id or property_id, which would change notification channels."""
    round1, req = task["round1"], task["parsed_request"]["requirements"]
    scores = scores_by_property(opinions)
    order = [p for p in combined_ranking(scores) if p not in unavailable]
    ranked = [chosen] + [p for p in order if p != chosen]
    p = pool.by_id[chosen]
    risks = [r for _, r in risk_signals(p, Peers(pool).price_ratio(p))]
    alt = next((o["property_id"] for o in round1["options"] if o["property_id"] not in (chosen, *unavailable)), None) or (ranked[1] if len(ranked) > 1 else None)
    alternative = None
    if alt:
        q = pool.by_id[alt]
        why = risk_signals(q, Peers(pool).price_ratio(q))
        gap = mean(scores[chosen].values()) - mean(scores[alt].values())
        missed = failures(q, req)
        alternative = {"property_id": alt, "why_lower": (
            f"does not meet {', '.join(missed)}" if missed else why[0][1] if why
            else f"the agents' combined score is {gap:.2f} lower" if gap > 0 else "fewer agents voted for it")}
    agree = sum(b == chosen for b in ballots.values()) / len(round1["voters"])
    dissent = [{"agent": a, "position": pid, "reason": votes[a]["reason"]} for a, pid in ballots.items() if pid != chosen]
    if decision["mode"] == "forced":
        dissent.append({"agent": "chair", "position": chosen, "reason": " ".join(decision["notes"])})
    t = task["timings"]
    result = {
        "task_id": task["task_id"], "trace_id": task["trace_id"], "plan_id": task["plan_id"], "user_id": task["user_id"],
        "config_version": task["config_version"],
        "recommended": {"property_id": chosen, "score": round(mean(scores[chosen].values()), 2)},
        "ranked": ranked[:10],
        "confidence": round(mean(o["confidence"] for o in opinions.values()) * (0.6 + 0.4 * agree), 2),
        "rationale": facts(p, req), "risks": risks, "rejected_alternative": alternative,
        "decision": {"mode": decision["mode"], "votes": counts}, "dissent": dissent, "limitations": limitations,
        "availability": availability, "explanation": "", "human_decision": None,
        "parsed_request": req, "disagreement_score": round1["disagreement_score"], "challenges": round1["challenges"],
        "opinions": [{"agent": a, "top3": top3(o), "confidence": o["confidence"]} for a, o in opinions.items()],
        "vote_details": [{"agent": a, "choice": v["choice"], "chosen": v.get("property_id"), "reason": v["reason"]} for a, v in votes.items()],
        "eligible_count": sum(not failures(q, req) for q in pool.properties),
        "timings_ms": {"total": elapsed_ms(task["created_at"], now), "parse": elapsed_ms(task["created_at"], t.get("round0_started")),
                       "round0": elapsed_ms(t.get("round0_started"), t.get("round0_closed")),
                       "debate": elapsed_ms(t.get("round0_closed"), t.get("round2_closed")),
                       "decide": elapsed_ms(t.get("round2_closed"), now)},
    }
    result["explanation"] = explain(result, pool)
    return result

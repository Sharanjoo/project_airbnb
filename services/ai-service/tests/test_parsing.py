import asyncio
from datetime import date

import pytest

from agents.parsing import ParseError, parse_request, parse_text
from app.llm import LLMError, OllamaProvider, get_provider
from app import config
from app.pool import load_pool

TODAY = date(2026, 11, 24)


class FakeLLM:
    name = "fake"

    def __init__(self, reply):
        self.reply = reply

    async def complete_json(self, *_):
        if isinstance(self.reply, Exception):
            raise self.reply
        return self.reply


def parse(text=None, provider=None, **payload):
    return asyncio.run(parse_request({"request_text": text, **payload}, load_pool(), provider=provider, today=TODAY))


def req(text=None, **payload):
    return parse(text, **payload)["requirements"]


def test_request_from_the_brief():
    assert req("two nights in San Jose under $250 with parking") == {
        "city": "San Jose", "check_in": None, "check_out": None, "guests": None, "price_max": 250.0,
        "amenities": ["parking"], "min_rating": None, "nights": 2}


def test_request_from_the_api_doc():
    r = req("I need a two-night stay in San Jose for two people, under $250 per night, with parking and a kitchen, "
            "rating at least 4.5", check_in="2026-11-14", check_out="2026-11-16")
    assert r == {"city": "San Jose", "check_in": "2026-11-14", "check_out": "2026-11-16", "guests": 2, "price_max": 250.0,
                 "amenities": ["kitchen", "parking"], "min_rating": 4.5, "nights": 2}


@pytest.mark.parametrize("text,city", [("a place in SF", "San Francisco"), ("cabin near Tahoe", "South Lake Tahoe"),
                                       ("palo alto condo", "Palo Alto"), ("not in Oakland, in Napa", "Napa"), ("in Paris", None)])
def test_city(text, city):
    assert req(text)["city"] == city


@pytest.mark.parametrize("text,n", [("family of 4", 4), ("2 adults and 2 kids", 4), ("for three guests", 3), ("a couple trip", 2),
                                    ("a couple of nights", None), ("for 3 nights", None), ("solo trip", 1), ("sleeps six", 6),
                                    ("for 2", 2), ("for 250 dollars", None), ("Palo Alto for 2, max $300", 2),
                                    ("for 2. Wifi", 2), ("for 2.5 hours", None), ("for 2,000 dollars", None)])
def test_guests(text, n):
    assert req(text)["guests"] == n


@pytest.mark.parametrize("text,price", [
    ("below $1,200", 1200), ("up to 180", 180), ("$150 or less", 150), ("between $100 and $200", 200), ("$100-$180 range", 180),
    ("budget of $99.50", 99.5), ("$120 per night", 120), ("under 5 miles away", None), ("up to 4 guests", None),
    ("over $100 a night", None), ("max 300", 300), ("$300 max", 300), ("no more than $90", 90)])
def test_price(text, price):
    assert req(text)["price_max"] == price


def test_total_budget_is_divided_by_nights():
    out = parse("3 nights under $600 total")
    assert out["requirements"]["price_max"] == 200 and out["warnings"]


@pytest.mark.parametrize("text,rating", [("rated 4.5 or higher", 4.5), ("at least 4 stars", 4), ("4.8+ rating", 4.8),
                                         ("4.5+ please", 4.5), ("highly rated", None), ("4+ guests", None), ("5 nights", None)])
def test_rating(text, rating):
    assert req(text)["min_rating"] == rating


@pytest.mark.parametrize("text,names", [
    ("wi-fi, laundry and air conditioning", ["wifi", "washer", "ac"]), ("bringing my dog", ["pet_friendly"]),
    ("no parking needed but a pool", ["pool"]), ("without a pool", []), ("I don't need parking", []),
    ("with a pool table", []), ("desk and self check-in", ["workspace", "self_checkin"])])
def test_amenities(text, names):
    assert req(text)["amenities"] == names


@pytest.mark.parametrize("text,start,end", [
    ("2026-12-05 to 2026-12-08", "2026-12-05", "2026-12-08"), ("December 5-7", "2026-12-05", "2026-12-07"),
    ("Dec 5th to Jan 2", "2026-12-05", "2027-01-02"), ("jan 3, 2 nights", "2027-01-03", "2027-01-05"),
    ("tomorrow for 2 nights", "2026-11-25", "2026-11-27"), ("Feb 30", None, None), ("next weekend", None, None)])
def test_dates(text, start, end):
    r = req(text)
    assert (r["check_in"], r["check_out"]) == (start, end)


def test_structured_wins_over_text_and_amenities_combine():
    r = req("San Jose under $250 with parking", structured={"city": "napa", "price_max": 400, "amenities": ["Self-Checkin"]})
    assert (r["city"], r["price_max"], r["amenities"]) == ("Napa", 400, ["parking", "self_checkin"])


def test_structured_only():
    assert req(structured={"city": "Fresno", "guests": 3})["guests"] == 3


@pytest.mark.parametrize("text,payload,field", [
    (None, {"structured": {"city": "Paris"}}, "structured.city"), (None, {"structured": {"amenities": ["sauna"]}}, "structured.amenities"),
    ("2026-12-01 to 2027-02-01", {}, "check_out"), ("for 20 guests", {}, "guests"),
    ("Napa Dec 5", {"check_out": "2026-12-01"}, "check_out"), ("Napa", {"check_in": "soon"}, "check_in")])
def test_unusable_requests_give_a_clear_error(text, payload, field):
    with pytest.raises(ParseError) as e:
        parse(text, **payload)
    assert e.value.field == field


def test_ambiguity_is_reported():
    assert "Several cities" in parse("San Jose or Oakland")["warnings"][0]
    assert "dates" in parse("Napa next weekend")["warnings"][0]
    assert "whole pool" in parse("surprise me please")["warnings"][0]


def test_llm_fills_only_gaps_and_must_quote_the_request():
    reply = {"city": {"value": "San Francisco", "quote": "San Fransisco"}, "guests": {"value": 3, "quote": "three pals"},
             "price_max": {"value": 999, "quote": "under $200"}, "min_rating": {"value": 5, "quote": "amazing"},
             "amenities": [{"value": "workspace", "quote": "somewhere to work"}, {"value": "pool", "quote": "swim"}]}
    out = parse("San Fransisco with three pals under $200, somewhere to work", FakeLLM(reply))
    r = out["requirements"]
    assert (r["city"], r["guests"], r["price_max"], r["min_rating"], r["amenities"]) == ("San Francisco", 3, 200, None, ["workspace"])
    assert out["llm_fields"] == ["city", "guests", "amenities"] and out["provider"] == "fake"


def test_llm_cannot_guess_a_city_or_add_a_refused_amenity():
    reply = {"city": {"value": "Santa Cruz", "quote": "by the beach"}, "amenities": [{"value": "pool", "quote": "pool"}]}
    r = parse("by the beach without a pool", FakeLLM(reply))["requirements"]
    assert r["city"] is None and r["amenities"] == []


def test_an_llm_amenity_quote_must_name_the_amenity():
    # Found by the benchmark (R48): the quote was in the request but said nothing about a pool.
    reply = {"amenities": [{"value": "pool", "quote": "a big house"}, {"value": "ac", "quote": "family reunion"},
                           {"value": "self_checkin", "quote": "keyless entry"}, {"value": "kitchen", "quote": "cook dinner"}]}
    r = parse("A big house for a family reunion, keyless entry, somewhere to cook dinner", FakeLLM(reply))["requirements"]
    assert r["amenities"] == ["kitchen", "self_checkin"]


@pytest.mark.parametrize("reply", [{}, {"city": 5, "guests": [], "amenities": "x"}, {"amenities": [None, {"value": []}]},
                                   {"guests": {"value": True, "quote": "San Jose"}}, {"city": {"value": None, "quote": "San Jose"}}])
def test_malformed_llm_output_is_harmless(reply):
    assert parse("San Jose under $250", FakeLLM(reply))["requirements"]["price_max"] == 250


def test_llm_failure_falls_back_to_rules():
    out = parse("San Jose under $250", FakeLLM(LLMError("down")))
    assert out["fallback"] == "llm_error" and out["requirements"]["city"] == "San Jose"


def test_provider_selection(monkeypatch):
    assert get_provider() is None
    monkeypatch.setattr(config, "LLM_PROVIDER", "ollama")
    assert isinstance(get_provider(), OllamaProvider)
    monkeypatch.setattr(config, "LLM_PROVIDER", "nope")
    with pytest.raises(ValueError):
        get_provider()


def test_ollama_unreachable_is_an_llm_error(monkeypatch):
    monkeypatch.setattr(config, "LLM_BASE_URL", "http://127.0.0.1:1")
    with pytest.raises(LLMError):
        asyncio.run(OllamaProvider().complete_json("s", "u", {}))


@pytest.mark.parametrize("text", ["a stay in Napa below 400 dollars a night", "Napa, $250 a night", "Napa under $250/night", "Napa 90 usd per night"])
def test_a_price_per_night_is_not_a_one_night_stay(text):
    assert parse_text(text.lower(), load_pool(), TODAY)[0].get("nights") is None


def test_one_night_is_still_understood():
    assert parse_text("one night in napa", load_pool(), TODAY)[0]["nights"] == 1
    assert parse_text("napa for a night, under $250 a night", load_pool(), TODAY)[0]["nights"] == 1


@pytest.mark.parametrize("text", ["nothing over 200", "nothing above $200", "not more than 200 dollars", "no more than $200"])
def test_negated_price_limits(text):
    assert parse_text(f"oakland, {text}", load_pool(), TODAY)[0]["price_max"] == 200

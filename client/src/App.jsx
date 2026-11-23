import { NavLink, Route, Routes } from 'react-router-dom';
import Login from './pages/Login.jsx';
import Search from './pages/guest/Search.jsx';
import PropertyDetail from './pages/guest/PropertyDetail.jsx';
import MyBookings from './pages/guest/MyBookings.jsx';
import GuestDashboard from './pages/guest/GuestDashboard.jsx';
import AiRecommend from './pages/guest/AiRecommend.jsx';
import Messages from './pages/shared/Messages.jsx';
import HostListings from './pages/host/HostListings.jsx';
import HostRequests from './pages/host/HostRequests.jsx';
import HostDashboard from './pages/host/HostDashboard.jsx';
import PlatformDashboard from './pages/admin/PlatformDashboard.jsx';
import { logout } from './api/client.js';
import { useSession } from './api/useSession.js';

// Page owners (see TEAM.md):
//   Slice 1: Login, Messages        Slice 2: Search, PropertyDetail, HostListings
//   Slice 3: MyBookings, HostRequests   Slice 4: dashboards   Slice 5: AiRecommend

// Links shown for each role. This only tidies the menu: every page still checks
// the role itself, and the gateway and services enforce it on every call.
const NAV = {
  anonymous: [['/', 'Search'], ['/ai', 'AI match']],
  guest: [['/', 'Search'], ['/ai', 'AI match'], ['/bookings', 'My trips'], ['/messages', 'Messages'], ['/dashboards/guest', 'Dashboard']],
  host: [['/', 'Search'], ['/host/listings', 'Listings'], ['/host/requests', 'Requests'], ['/messages', 'Messages'], ['/dashboards/host', 'Dashboard']],
  admin: [['/', 'Search'], ['/ai', 'AI match'], ['/host/listings', 'Listings'], ['/host/requests', 'Requests'], ['/dashboards/platform', 'Platform']],
};

export default function App() {
  const session = useSession();
  const links = NAV[session?.role] || NAV.anonymous;
  return (
    <div className="app">
      <header className="topbar">
        <strong>Staybook</strong>
        <nav>
          {links.map(([to, text]) => <NavLink key={to} to={to} end={to === '/'}>{text}</NavLink>)}
        </nav>
        {session ? (
          <span className="session">
            <span className="muted">{session.user_id} · {session.role}</span>
            <button onClick={logout}>Log out</button>
          </span>
        ) : (
          <NavLink to="/login">Log in / Sign up</NavLink>
        )}
      </header>
      <main>
        <Routes>
          <Route path="/" element={<Search />} />
          <Route path="/login" element={<Login />} />
          <Route path="/properties/:propertyId" element={<PropertyDetail />} />
          <Route path="/bookings" element={<MyBookings />} />
          <Route path="/messages" element={<Messages />} />
          <Route path="/ai" element={<AiRecommend />} />
          <Route path="/dashboards/guest" element={<GuestDashboard />} />
          <Route path="/host/listings" element={<HostListings />} />
          <Route path="/host/requests" element={<HostRequests />} />
          <Route path="/dashboards/host" element={<HostDashboard />} />
          <Route path="/dashboards/platform" element={<PlatformDashboard />} />
        </Routes>
      </main>
    </div>
  );
}

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
import { getSession, logout } from './api/client.js';

// Page owners (see TEAM.md):
//   Slice 1: Login, Messages        Slice 2: Search, PropertyDetail, HostListings
//   Slice 3: MyBookings, HostRequests   Slice 4: dashboards   Slice 5: AiRecommend
export default function App() {
  const session = getSession();
  return (
    <div className="app">
      <header className="topbar">
        <strong>Staybook</strong>
        <nav>
          <NavLink to="/">Search</NavLink>
          <NavLink to="/ai">AI match</NavLink>
          <NavLink to="/bookings">My trips</NavLink>
          <NavLink to="/messages">Messages</NavLink>
          <NavLink to="/host/listings">Host</NavLink>
          <NavLink to="/dashboards/platform">Platform</NavLink>
        </nav>
        {session ? (
          <button onClick={logout}>Log out {session.user_id}</button>
        ) : (
          <NavLink to="/login">Log in</NavLink>
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

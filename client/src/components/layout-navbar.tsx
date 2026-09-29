import { Link, useLocation } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Gamepad2, LayoutDashboard, LogOut, User as UserIcon, Settings, Menu, X } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { ProfileModal } from "@/components/profile-modal";
import { useState } from "react";

import logoImg from "@assets/PLAY_N_SLAY_LOGO__1768593233107.jpeg";

export function Navbar() {
  const { user, logoutMutation } = useAuth();
  const [location] = useLocation();
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  const handleLogout = () => {
    logoutMutation.mutate();
    setIsMobileMenuOpen(false);
  };

  // Get initials for avatar
  const initials = user?.username
    ? user.username.substring(0, 2).toUpperCase()
    : "GU";

  return (
    <nav className="fixed top-0 left-0 right-0 h-16 border-b border-white/10 bg-background/90 backdrop-blur-md z-50">
      <div className="container mx-auto h-full px-4 flex items-center justify-between">
        {/* Logo */}
        <Link href="/" className="flex items-center gap-2 group cursor-pointer" onClick={() => setIsMobileMenuOpen(false)}>
          <div className="h-9 w-9 sm:h-10 sm:w-10 overflow-hidden rounded-lg border border-primary/50 group-hover:shadow-[0_0_15px_rgba(0,243,255,0.5)] transition-all shrink-0">
            <img src={typeof logoImg === 'string' ? logoImg : (logoImg as any)?.src || ""} alt="Play N' Slay Logo" className="h-full w-full object-cover" />
          </div>
          <span className="text-lg sm:text-xl font-bold font-display tracking-wider group-hover:text-primary transition-colors">
            PLAY N'<span className="text-primary">SLAY</span>
          </span>
        </Link>

        {/* Desktop Nav */}
        <div className="hidden md:flex items-center gap-5">
          <Link href="/games" className={`text-sm font-medium transition-colors hover:text-primary flex items-center gap-1.5 ${location === '/games' ? 'text-primary font-semibold' : 'text-muted-foreground'}`}>
            <Gamepad2 className="w-4 h-4" />
            <span>Games Catalog</span>
          </Link>
          <Link href="/contact" className={`text-sm font-medium transition-colors hover:text-primary ${location === '/contact' ? 'text-primary font-semibold' : 'text-muted-foreground'}`}>
            Contact Us
          </Link>
          {!user ? (
            <Link href="/auth">
              <Button variant="default" className="bg-primary text-primary-foreground hover:bg-primary/90 hover:shadow-[0_0_20px_rgba(0,243,255,0.4)] transition-all">
                Login / Join
              </Button>
            </Link>
          ) : (
            <div className="flex items-center gap-4">
              {user.role === 'admin' ? (
                <Link href="/admin">
                  <Button variant="ghost" className={location.startsWith('/admin') ? "text-primary bg-primary/10" : "text-muted-foreground hover:text-foreground"}>
                    Admin Command
                  </Button>
                </Link>
              ) : null}

              {user.role === 'employee' || user.role === 'admin' ? (
                <Link href="/employee">
                  <Button variant="default" className="bg-secondary text-secondary-foreground hover:bg-secondary/90 hover:shadow-[0_0_15px_rgba(168,85,247,0.4)] transition-all">
                    Staff Station
                  </Button>
                </Link>
              ) : null}

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" className="relative h-10 w-10 rounded-full border border-primary/30 p-0 overflow-hidden hover:shadow-[0_0_10px_rgba(0,243,255,0.3)] transition-all">
                    <Avatar className="h-full w-full">
                      {user.avatarUrl ? (
                        <AvatarImage src={user.avatarUrl} alt={user.username} className="object-cover" />
                      ) : null}
                      <AvatarFallback className="bg-background text-primary font-bold">
                        {initials}
                      </AvatarFallback>
                    </Avatar>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent className="w-56 bg-card border-white/10" align="end">
                  <div className="flex items-center justify-start gap-2 p-2">
                    <div className="flex flex-col space-y-1 leading-none">
                      <p className="font-medium">{user.username}</p>
                      <p className="text-xs leading-none text-muted-foreground">
                        {user.role === 'admin' ? "Administrator" : user.role === 'employee' ? "Employee" : "Member"}
                      </p>
                    </div>
                  </div>
                  <DropdownMenuSeparator className="bg-white/10" />
                  <DropdownMenuItem onClick={() => setIsProfileOpen(true)} className="cursor-pointer flex items-center">
                    <Settings className="mr-2 h-4 w-4 text-primary" />
                    <span>Profile & Settings</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link href="/dashboard" className="cursor-pointer flex items-center">
                      <UserIcon className="mr-2 h-4 w-4" />
                      <span>My Bookings</span>
                    </Link>
                  </DropdownMenuItem>
                  {user.role === 'employee' || user.role === 'admin' ? (
                    <DropdownMenuItem asChild>
                      <Link href="/employee" className="cursor-pointer flex items-center">
                        <LayoutDashboard className="mr-2 h-4 w-4" />
                        <span>Employee Panel</span>
                      </Link>
                    </DropdownMenuItem>
                  ) : null}
                  {user.role === 'admin' && (
                    <DropdownMenuItem asChild>
                      <Link href="/admin" className="cursor-pointer flex items-center">
                        <LayoutDashboard className="mr-2 h-4 w-4" />
                        <span>Admin Dashboard</span>
                      </Link>
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuSeparator className="bg-white/10" />
                  <DropdownMenuItem onClick={handleLogout} className="text-red-400 focus:text-red-400 focus:bg-red-400/10 cursor-pointer">
                    <LogOut className="mr-2 h-4 w-4" />
                    <span>Log out</span>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
        </div>

        {/* Mobile Nav Toggle & User Quick Avatar */}
        <div className="flex md:hidden items-center gap-2">
          {user && (
            <button
              onClick={() => setIsProfileOpen(true)}
              className="relative h-9 w-9 rounded-full border border-primary/30 overflow-hidden"
              title="Profile & Settings"
            >
              <Avatar className="h-full w-full">
                {user.avatarUrl ? (
                  <AvatarImage src={user.avatarUrl} alt={user.username} className="object-cover" />
                ) : null}
                <AvatarFallback className="bg-background text-primary font-bold text-xs">
                  {initials}
                </AvatarFallback>
              </Avatar>
            </button>
          )}

          <Button
            variant="ghost"
            size="icon"
            onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
            className="h-10 w-10 text-foreground hover:bg-white/10"
            aria-label="Toggle Navigation Menu"
          >
            {isMobileMenuOpen ? <X className="h-6 w-6 text-primary" /> : <Menu className="h-6 w-6" />}
          </Button>
        </div>
      </div>

      {/* Mobile Drawer Menu */}
      {isMobileMenuOpen && (
        <div className="md:hidden border-b border-white/10 bg-background/95 backdrop-blur-xl px-4 py-4 space-y-2 shadow-2xl animate-in slide-in-from-top-2 duration-200">
          <Link
            href="/games"
            onClick={() => setIsMobileMenuOpen(false)}
            className={`flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
              location === '/games' ? 'bg-primary/10 text-primary font-bold' : 'text-muted-foreground hover:text-foreground hover:bg-white/5'
            }`}
          >
            <Gamepad2 className="w-4 h-4 text-primary" />
            <span>Games Catalog</span>
          </Link>

          <Link
            href="/contact"
            onClick={() => setIsMobileMenuOpen(false)}
            className={`flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
              location === '/contact' ? 'bg-primary/10 text-primary font-bold' : 'text-muted-foreground hover:text-foreground hover:bg-white/5'
            }`}
          >
            <span>Contact Us</span>
          </Link>

          {user && (
            <Link
              href="/dashboard"
              onClick={() => setIsMobileMenuOpen(false)}
              className={`flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                location === '/dashboard' ? 'bg-primary/10 text-primary font-bold' : 'text-muted-foreground hover:text-foreground hover:bg-white/5'
              }`}
            >
              <UserIcon className="w-4 h-4 text-secondary" />
              <span>My Bookings</span>
            </Link>
          )}

          {user && user.role === 'admin' && (
            <Link
              href="/admin"
              onClick={() => setIsMobileMenuOpen(false)}
              className={`flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                location.startsWith('/admin') ? 'bg-primary/15 text-primary font-bold' : 'text-primary hover:bg-primary/10'
              }`}
            >
              <LayoutDashboard className="w-4 h-4" />
              <span>Admin Command</span>
            </Link>
          )}

          {user && (user.role === 'employee' || user.role === 'admin') && (
            <Link
              href="/employee"
              onClick={() => setIsMobileMenuOpen(false)}
              className={`flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                location.startsWith('/employee') ? 'bg-secondary/15 text-secondary font-bold' : 'text-secondary hover:bg-secondary/10'
              }`}
            >
              <LayoutDashboard className="w-4 h-4" />
              <span>Staff Station</span>
            </Link>
          )}

          {user && (
            <button
              onClick={() => {
                setIsProfileOpen(true);
                setIsMobileMenuOpen(false);
              }}
              className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-white/5 text-left"
            >
              <Settings className="w-4 h-4 text-primary" />
              <span>Profile & Settings</span>
            </button>
          )}

          <div className="pt-2 border-t border-white/10">
            {!user ? (
              <Link href="/auth" onClick={() => setIsMobileMenuOpen(false)}>
                <Button className="w-full bg-primary text-primary-foreground font-bold shadow-[0_0_15px_rgba(0,243,255,0.3)]">
                  Login / Join
                </Button>
              </Link>
            ) : (
              <Button
                variant="outline"
                onClick={handleLogout}
                className="w-full border-red-500/30 text-red-400 hover:bg-red-500/10 justify-center"
              >
                <LogOut className="w-4 h-4 mr-2" /> Log out
              </Button>
            )}
          </div>
        </div>
      )}

      <ProfileModal open={isProfileOpen} onOpenChange={setIsProfileOpen} />
    </nav>
  );
}

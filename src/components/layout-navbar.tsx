"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Gamepad2, LayoutDashboard, LogOut, User as UserIcon } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";

export function Navbar() {
  const { user, logoutMutation } = useAuth();
  const pathname = usePathname();

  const handleLogout = () => {
    logoutMutation.mutate();
  };

  // Get initials for avatar
  const initials = user?.username
    ? user.username.substring(0, 2).toUpperCase()
    : "GU";

  return (
    <nav className="fixed top-0 left-0 right-0 h-16 border-b border-white/10 bg-background/80 backdrop-blur-md z-50">
      <div className="container mx-auto h-full px-4 flex items-center justify-between">
        {/* Logo */}
        <Link href="/" className="flex items-center gap-2 group cursor-pointer">
          <div className="h-10 w-10 overflow-hidden rounded-lg border border-primary/50 group-hover:shadow-[0_0_15px_rgba(0,243,255,0.5)] transition-all">
            <img
              src="/assets/PLAY_N_SLAY_LOGO__1768593233107.jpeg"
              alt="Play N' Slay Logo"
              className="h-full w-full object-cover"
            />
          </div>
          <span className="text-xl font-bold font-display tracking-wider group-hover:text-primary transition-colors">
            PLAY N&apos;<span className="text-primary">SLAY</span>
          </span>
        </Link>

        {/* Desktop Nav */}
        <div className="flex items-center gap-4">
          <Link
            href="/contact"
            className={`text-sm font-medium transition-colors hover:text-primary ${
              pathname === "/contact" ? "text-primary" : "text-muted-foreground"
            }`}
          >
            Contact Us
          </Link>
          {!user ? (
            <Link href="/auth">
              <Button
                variant="default"
                className="bg-primary text-primary-foreground hover:bg-primary/90 hover:shadow-[0_0_20px_rgba(0,243,255,0.4)] transition-all"
              >
                Login / Join
              </Button>
            </Link>
          ) : (
            <div className="flex items-center gap-4">
              {user.role === "admin" ? (
                <Link href="/admin">
                  <Button
                    variant="ghost"
                    className={
                      pathname?.startsWith("/admin")
                        ? "text-primary bg-primary/10"
                        : "text-muted-foreground hover:text-foreground"
                    }
                  >
                    Admin Command
                  </Button>
                </Link>
              ) : null}

              {user.role === "employee" || user.role === "admin" ? (
                <Link href="/employee">
                  <Button
                    variant="default"
                    className="bg-secondary text-secondary-foreground hover:bg-secondary/90 hover:shadow-[0_0_15px_rgba(168,85,247,0.4)] transition-all"
                  >
                    Staff Station
                  </Button>
                </Link>
              ) : null}

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    className="relative h-10 w-10 rounded-full border border-primary/30 p-0 overflow-hidden hover:shadow-[0_0_10px_rgba(0,243,255,0.3)] transition-all"
                  >
                    <Avatar className="h-full w-full">
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
                        {user.role === "admin"
                          ? "Administrator"
                          : user.role === "employee"
                          ? "Employee"
                          : "Member"}
                      </p>
                    </div>
                  </div>
                  <DropdownMenuSeparator className="bg-white/10" />
                  <DropdownMenuItem asChild>
                    <Link href="/dashboard" className="cursor-pointer flex items-center w-full">
                      <UserIcon className="mr-2 h-4 w-4" />
                      <span>My Bookings</span>
                    </Link>
                  </DropdownMenuItem>
                  {user.role === "employee" || user.role === "admin" ? (
                    <DropdownMenuItem asChild>
                      <Link href="/employee" className="cursor-pointer flex items-center w-full">
                        <LayoutDashboard className="mr-2 h-4 w-4" />
                        <span>Employee Panel</span>
                      </Link>
                    </DropdownMenuItem>
                  ) : null}
                  {user.role === "admin" && (
                    <DropdownMenuItem asChild>
                      <Link href="/admin" className="cursor-pointer flex items-center w-full">
                        <LayoutDashboard className="mr-2 h-4 w-4" />
                        <span>Admin Dashboard</span>
                      </Link>
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuSeparator className="bg-white/10" />
                  <DropdownMenuItem
                    onClick={handleLogout}
                    className="text-red-400 focus:text-red-400 focus:bg-red-400/10 cursor-pointer"
                  >
                    <LogOut className="mr-2 h-4 w-4" />
                    <span>Log out</span>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
        </div>
      </div>
    </nav>
  );
}

import React, { useState } from "react";
import { Link, useLocation } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { Home, Gamepad2, CalendarPlus, User, Settings, LogIn } from "lucide-react";
import { cn } from "@/lib/utils";
import { ProfileModal } from "@/components/profile-modal";

export function MobileBottomNav() {
  const [location, setLocation] = useLocation();
  const { user } = useAuth();
  const [isProfileOpen, setIsProfileOpen] = useState(false);

  // Hide on admin and employee portals (those have their own sidebar/drawer)
  if (location.startsWith("/admin") || location.startsWith("/employee")) {
    return null;
  }

  const handleBookNowClick = (e: React.MouseEvent) => {
    if (location === "/") {
      e.preventDefault();
      const el = document.getElementById("booking-section");
      if (el) {
        el.scrollIntoView({ behavior: "smooth" });
      }
    } else {
      setLocation("/#booking-section");
    }
  };

  return (
    <>
      <nav
        aria-label="Mobile Navigation"
        className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-background/95 backdrop-blur-xl border-t border-white/10 pb-safe shadow-[0_-4px_25px_rgba(0,0,0,0.5)]"
      >
        <div className="grid grid-cols-5 h-16 items-center px-1">
          {/* 1. Home */}
          <Link
            href="/"
            className={cn(
              "flex flex-col items-center justify-center h-full touch-target transition-colors",
              location === "/" ? "text-primary font-bold" : "text-muted-foreground hover:text-foreground"
            )}
          >
            <Home className={cn("w-5 h-5", location === "/" && "stroke-[2.5px]")} />
            <span className="text-[10px] mt-1 tracking-tight">Home</span>
          </Link>

          {/* 2. Games Catalog */}
          <Link
            href="/games"
            className={cn(
              "flex flex-col items-center justify-center h-full touch-target transition-colors",
              location === "/games" ? "text-primary font-bold" : "text-muted-foreground hover:text-foreground"
            )}
          >
            <Gamepad2 className={cn("w-5 h-5", location === "/games" && "stroke-[2.5px]")} />
            <span className="text-[10px] mt-1 tracking-tight">Games</span>
          </Link>

          {/* 3. Book Now (Highlighted Center Action) */}
          <button
            onClick={handleBookNowClick}
            type="button"
            className="flex flex-col items-center justify-center h-full touch-target group cursor-pointer"
          >
            <div className="w-10 h-10 -mt-3 rounded-full bg-gradient-to-r from-primary to-secondary text-primary-foreground flex items-center justify-center shadow-[0_0_15px_rgba(0,243,255,0.4)] group-active:scale-95 transition-transform">
              <CalendarPlus className="w-5 h-5 text-black stroke-[2.5px]" />
            </div>
            <span className="text-[10px] mt-0.5 font-bold text-primary tracking-tight">Book</span>
          </button>

          {/* 4. Bookings / Dashboard */}
          <Link
            href={user ? "/dashboard" : "/auth"}
            className={cn(
              "flex flex-col items-center justify-center h-full touch-target transition-colors",
              location === "/dashboard" ? "text-primary font-bold" : "text-muted-foreground hover:text-foreground"
            )}
          >
            <User className={cn("w-5 h-5", location === "/dashboard" && "stroke-[2.5px]")} />
            <span className="text-[10px] mt-1 tracking-tight">{user ? "Bookings" : "Login"}</span>
          </Link>

          {/* 5. Profile or Auth */}
          {user ? (
            <button
              onClick={() => setIsProfileOpen(true)}
              type="button"
              className="flex flex-col items-center justify-center h-full touch-target text-muted-foreground hover:text-foreground cursor-pointer transition-colors"
            >
              <Settings className="w-5 h-5" />
              <span className="text-[10px] mt-1 tracking-tight">Profile</span>
            </button>
          ) : (
            <Link
              href="/auth"
              className={cn(
                "flex flex-col items-center justify-center h-full touch-target transition-colors",
                location === "/auth" ? "text-primary font-bold" : "text-muted-foreground hover:text-foreground"
              )}
            >
              <LogIn className="w-5 h-5" />
              <span className="text-[10px] mt-1 tracking-tight">Join</span>
            </Link>
          )}
        </div>
      </nav>

      <ProfileModal open={isProfileOpen} onOpenChange={setIsProfileOpen} />
    </>
  );
}

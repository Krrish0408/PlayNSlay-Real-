"use client";

import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { EmployeeSidebar } from "@/components/employee-sidebar";
import { Button } from "@/components/ui/button";
import { Home } from "lucide-react";
import Link from "next/link";

export default function EmployeeLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <SidebarProvider>
      <div className="flex h-screen w-full overflow-hidden bg-background">
        <EmployeeSidebar />
        <main className="flex-1 overflow-auto bg-background">
          <div className="p-4 border-b border-white/5 flex items-center justify-between sticky top-0 bg-background/80 backdrop-blur-md z-10">
            <div className="flex items-center gap-4">
              <SidebarTrigger />
              <span className="font-display font-bold tracking-tight">
                EMPLOYEE{" "}
                <span className="text-primary text-xs ml-2 px-2 py-0.5 rounded border border-primary/20 bg-primary/10 uppercase">
                  Portal
                </span>
              </span>
            </div>
            <Link href="/">
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground hover:text-primary gap-2 transition-colors"
              >
                <Home className="w-4 h-4" />
                <span className="hidden sm:inline">Back to Home</span>
              </Button>
            </Link>
          </div>
          <div className="p-6">{children}</div>
        </main>
      </div>
    </SidebarProvider>
  );
}

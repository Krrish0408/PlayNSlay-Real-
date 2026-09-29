import { Sidebar, SidebarContent, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarHeader } from "@/components/ui/sidebar";
import { LayoutDashboard, PlusCircle, Clock, LogOut, Home, Gamepad2 } from "lucide-react";
import { Link, useLocation } from "wouter";
import { useAuth } from "@/hooks/use-auth";

const menuItems = [
  { title: "Dashboard", url: "/employee", icon: LayoutDashboard },
  { title: "Booking Entry", url: "/employee/entries", icon: PlusCircle },
  { title: "Recent History", url: "/employee/recent", icon: Clock },
];

export function EmployeeSidebar() {
  const { logoutMutation, user } = useAuth();
  const [location] = useLocation();

  return (
    <Sidebar className="border-r border-white/5 bg-card/50 backdrop-blur-xl">
      <SidebarHeader className="p-4 border-b border-white/5">
        <div className="flex items-center gap-3">
          <div className="h-8 w-8 rounded bg-primary/20 flex items-center justify-center border border-primary/30">
            <Gamepad2 className="w-5 h-5 text-primary" />
          </div>
          <div className="flex flex-col">
            <span className="text-sm font-display font-bold leading-none tracking-tight">STAFF <span className="text-primary">PANEL</span></span>
            <span className="text-[10px] text-muted-foreground uppercase tracking-widest mt-1">Lounge Manager</span>
          </div>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel className="text-[10px] uppercase tracking-tighter text-muted-foreground px-4 mb-2">Main Menu</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {menuItems.map((item) => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton asChild isActive={location === item.url} className="px-4 py-6 hover:bg-white/5">
                    <Link href={item.url} className="flex items-center gap-3">
                      <item.icon className={`w-5 h-5 ${location === item.url ? 'text-primary' : 'text-muted-foreground'}`} />
                      <span className={`font-display font-medium ${location === item.url ? 'text-foreground' : 'text-muted-foreground'}`}>{item.title}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup className="mt-auto border-t border-white/5">
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton asChild className="px-4 py-6 hover:bg-white/5">
                  <Link href="/">
                    <Home className="w-5 h-5 text-muted-foreground" />
                    <span className="font-display font-medium text-muted-foreground">Public Home</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton onClick={() => logoutMutation.mutate()} className="px-4 py-6 text-red-400 hover:text-red-300 hover:bg-red-400/5">
                  <LogOut className="w-5 h-5" />
                  <span className="font-display font-medium">Logout</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}

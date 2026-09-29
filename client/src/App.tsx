import { Switch, Route, Router as WouterRouter, Link } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import HomePage from "@/pages/home-page";
import AuthPage from "@/pages/auth-page";
import DashboardPage from "@/pages/dashboard-page";
import AdminDashboard from "@/pages/admin-dashboard";
import EmployeeDashboard from "@/pages/employee-dashboard";
import BookingEntryPage from "@/pages/booking-entry-page";
import EmployeeRecentPage from "@/pages/employee-recent-page";
import ContactPage from "@/pages/contact-page";
import GamesPage from "@/pages/games-page";
import ResetPasswordPage from "@/pages/reset-password-page";
import { useAuth } from "@/hooks/use-auth";
import { Redirect } from "wouter";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { EmployeeSidebar } from "@/components/employee-sidebar";
import { Button } from "@/components/ui/button";
import { Home } from "lucide-react";

function ProtectedRoute({ component: Component, allowedRoles, ...rest }: any) {
  const { user, isLoading } = useAuth();
  if (isLoading) return null;
  if (!user) {
    const currentTarget = window.location.pathname + window.location.search + window.location.hash;
    const redirectUrl = currentTarget && currentTarget !== "/" ? `/auth?redirect=${encodeURIComponent(currentTarget)}` : "/auth";
    return <Redirect to={redirectUrl} />;
  }
  if (allowedRoles && !allowedRoles.includes(user.role)) return <Redirect to="/" />;
  return <Component {...rest} />;
}

function Router() {
  const { user } = useAuth();

  return (
    <Switch>
      <Route path="/" component={HomePage} />
      <Route path="/games" component={GamesPage} />
      <Route path="/auth" component={AuthPage} />
      <Route path="/contact" component={ContactPage} />
      <Route path="/reset-password" component={ResetPasswordPage} />
      <Route path="/dashboard">
        {() => <ProtectedRoute component={DashboardPage} />}
      </Route>
      <Route path="/admin">
        {() => <ProtectedRoute component={AdminDashboard} allowedRoles={['admin']} />}
      </Route>
      <Route path="/employee">
        {() => (
          <ProtectedRoute
            allowedRoles={['employee', 'admin']}
            component={() => (
              <SidebarProvider>
                <div className="flex h-screen w-full overflow-hidden">
                  <EmployeeSidebar />
                  <main className="flex-1 overflow-auto bg-background">
                    <div className="p-4 border-b border-white/5 flex items-center justify-between sticky top-0 bg-background/80 backdrop-blur-md z-10">
                      <div className="flex items-center gap-4">
                        <SidebarTrigger />
                        <span className="font-display font-bold tracking-tight">EMPLOYEE <span className="text-primary text-xs ml-2 px-2 py-0.5 rounded border border-primary/20 bg-primary/10 uppercase">Portal</span></span>
                      </div>
                      <Link href="/">
                        <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-primary gap-2 transition-colors">
                          <Home className="w-4 h-4" />
                          <span className="hidden sm:inline">Back to Home</span>
                        </Button>
                      </Link>
                    </div>
                    <div className="p-6">
                      <EmployeeDashboard />
                    </div>
                  </main>
                </div>
              </SidebarProvider>
            )}
          />
        )}
      </Route>
      <Route path="/employee/entries">
        {() => (
          <ProtectedRoute
            allowedRoles={['employee', 'admin']}
            component={() => (
              <SidebarProvider>
                <div className="flex h-screen w-full overflow-hidden">
                  <EmployeeSidebar />
                  <main className="flex-1 overflow-auto bg-background">
                    <div className="p-4 border-b border-white/5 flex items-center justify-between sticky top-0 bg-background/80 backdrop-blur-md z-10">
                      <div className="flex items-center gap-4">
                        <SidebarTrigger />
                        <span className="font-display font-bold tracking-tight">EMPLOYEE <span className="text-primary text-xs ml-2 px-2 py-0.5 rounded border border-primary/20 bg-primary/10 uppercase">Portal</span></span>
                      </div>
                      <Link href="/">
                        <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-primary gap-2 transition-colors">
                          <Home className="w-4 h-4" />
                          <span className="hidden sm:inline">Back to Home</span>
                        </Button>
                      </Link>
                    </div>
                    <div className="p-6">
                      <BookingEntryPage />
                    </div>
                  </main>
                </div>
              </SidebarProvider>
            )}
          />
        )}
      </Route>
      <Route path="/employee/recent">
        {() => (
          <ProtectedRoute
            allowedRoles={['employee', 'admin']}
            component={() => (
              <SidebarProvider>
                <div className="flex h-screen w-full overflow-hidden">
                  <EmployeeSidebar />
                  <main className="flex-1 overflow-auto bg-background">
                    <div className="p-4 border-b border-white/5 flex items-center justify-between sticky top-0 bg-background/80 backdrop-blur-md z-10">
                      <div className="flex items-center gap-4">
                        <SidebarTrigger />
                        <span className="font-display font-bold tracking-tight">EMPLOYEE <span className="text-primary text-xs ml-2 px-2 py-0.5 rounded border border-primary/20 bg-primary/10 uppercase">Portal</span></span>
                      </div>
                      <Link href="/">
                        <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-primary gap-2 transition-colors">
                          <Home className="w-4 h-4" />
                          <span className="hidden sm:inline">Back to Home</span>
                        </Button>
                      </Link>
                    </div>
                    <div className="p-6">
                      <EmployeeRecentPage />
                    </div>
                  </main>
                </div>
              </SidebarProvider>
            )}
          />
        )}
      </Route>
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Router />
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;

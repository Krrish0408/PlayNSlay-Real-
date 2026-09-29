import { useState, useEffect } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { Redirect } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Loader2, Gamepad2, KeyRound, Mail, CheckCircle2 } from "lucide-react";

export default function AuthPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  // Single credential registration (Username OR Phone OR Email + Password)
  const [regIdentifier, setRegIdentifier] = useState("");
  const [regPassword, setRegPassword] = useState("");
  const [regFullName, setRegFullName] = useState("");
  const [showOptionalName, setShowOptionalName] = useState(false);

  // Forgot Password modal state
  const [isForgotPasswordOpen, setIsForgotPasswordOpen] = useState(false);
  const [forgotEmail, setForgotEmail] = useState("");
  const [isForgotSubmitting, setIsForgotSubmitting] = useState(false);
  const [forgotSuccessMessage, setForgotSuccessMessage] = useState<string | null>(null);

  const { loginMutation, registerMutation, user } = useAuth();
  const { toast } = useToast();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const errorParam = params.get("error");
    if (errorParam) {
      const errorMap: Record<string, string> = {
        access_denied: "Google sign-in was cancelled.",
        invalid_state: "Security verification failed. Please try signing in again.",
        missing_code: "Google authorization code was missing.",
        google_not_configured: "Google OAuth credentials are not configured on this server.",
        session_error: "Failed to establish user session after Google sign-in.",
      };
      toast({
        title: "Sign-In Notice",
        description: errorMap[errorParam] || decodeURIComponent(errorParam),
        variant: "destructive",
      });
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }, [toast]);

  // Redirect if already logged in (honoring safe return redirect url if provided)
  if (user) {
    const params = new URLSearchParams(window.location.search);
    const redirectParam = params.get("redirect");
    const safeRedirect = redirectParam && redirectParam.startsWith("/") && !redirectParam.startsWith("/auth")
      ? redirectParam
      : null;

    if (user.role === 'employee') {
      return <Redirect to={safeRedirect || "/employee"} />;
    } else if (user.role === 'admin') {
      return <Redirect to={safeRedirect || "/admin"} />;
    } else {
      return <Redirect to={safeRedirect || "/dashboard"} />;
    }
  }

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    loginMutation.mutate({ username, password });
  };

  const handleRegister = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = regIdentifier.trim();
    if (!trimmed) {
      toast({
        title: "Missing Information",
        description: "Please enter your username, email, or phone number.",
        variant: "destructive",
      });
      return;
    }
    if (regPassword.length < 6) {
      toast({
        title: "Password Too Short",
        description: "Password must be at least 6 characters.",
        variant: "destructive",
      });
      return;
    }

    registerMutation.mutate({
      identifier: trimmed,
      password: regPassword,
      fullName: regFullName.trim() || undefined,
    } as any);
  };

  const handleGoogleSignIn = () => {
    window.location.href = "/api/auth/google";
  };

  const handleForgotPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!forgotEmail || !forgotEmail.trim()) {
      toast({
        title: "Email Required",
        description: "Please enter your registered email address.",
        variant: "destructive",
      });
      return;
    }

    setIsForgotSubmitting(true);
    setForgotSuccessMessage(null);
    try {
      const res = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: forgotEmail.trim() }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || "Failed to process password reset request.");
      }

      setForgotSuccessMessage(
        data.message || "If an account exists with this email, password reset instructions have been dispatched."
      );
      toast({
        title: "Request Dispatched",
        description: "Check your email for reset instructions.",
      });
    } catch (err: any) {
      toast({
        title: "Request Failed",
        description: err.message || "Unable to send reset instructions.",
        variant: "destructive",
      });
    } finally {
      setIsForgotSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen grid lg:grid-cols-2 bg-background">
      {/* Left Side - Form */}
      <div className="flex items-center justify-center p-4 sm:p-8">
        <div className="w-full max-w-md space-y-6 sm:space-y-8">
          <div className="text-center mb-6 sm:mb-8">
            <div className="inline-flex p-3 rounded-2xl bg-primary/10 mb-4 border border-primary/20">
              <Gamepad2 className="w-8 h-8 sm:w-10 sm:h-10 text-primary" />
            </div>
            <h1 className="text-2xl sm:text-3xl font-display font-bold tracking-tight">Welcome to Play N' Slay</h1>
            <p className="text-sm sm:text-base text-muted-foreground mt-2">Enter the grid to continue.</p>
          </div>

          {/* Continue with Google */}
          <div className="space-y-4">
            <Button
              type="button"
              variant="outline"
              onClick={handleGoogleSignIn}
              className="w-full h-12 bg-white/5 hover:bg-white/10 border-white/10 hover:border-white/20 text-foreground font-medium flex items-center justify-center gap-3 transition-all rounded-xl shadow-sm text-sm sm:text-base group"
            >
              <svg className="w-5 h-5 transition-transform group-hover:scale-110" viewBox="0 0 24 24">
                <path
                  fill="#4285F4"
                  d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                />
                <path
                  fill="#34A853"
                  d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                />
                <path
                  fill="#FBBC05"
                  d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
                />
                <path
                  fill="#EA4335"
                  d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
                />
              </svg>
              <span>Continue with Google</span>
            </Button>

            <div className="relative flex items-center justify-center">
              <div className="border-t border-white/10 w-full" />
              <span className="bg-background px-3 text-xs uppercase tracking-wider text-muted-foreground whitespace-nowrap">
                or continue with credentials
              </span>
              <div className="border-t border-white/10 w-full" />
            </div>
          </div>

          <Tabs defaultValue="login" className="w-full">
            <TabsList className="grid w-full grid-cols-2 bg-card border border-white/10 mb-6">
              <TabsTrigger value="login">Login</TabsTrigger>
              <TabsTrigger value="register">Register</TabsTrigger>
            </TabsList>
            
            <TabsContent value="login">
              <Card className="border-white/10 bg-card/50 backdrop-blur-sm">
                <form onSubmit={handleLogin}>
                  <CardHeader>
                    <CardTitle>Login</CardTitle>
                    <CardDescription>Access your account and bookings.</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="username">Username, Email, or Phone Number</Label>
                      <Input 
                        id="username" 
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        placeholder="e.g. member, alex@example.com, or +919876543210"
                        className="bg-background/50 border-white/10"
                        required 
                      />
                    </div>
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <Label htmlFor="password">Password</Label>
                        <button
                          type="button"
                          onClick={() => {
                            setForgotSuccessMessage(null);
                            setIsForgotPasswordOpen(true);
                          }}
                          className="text-xs text-primary hover:underline font-medium cursor-pointer"
                        >
                          Forgot Password?
                        </button>
                      </div>
                      <Input 
                        id="password" 
                        type="password" 
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        className="bg-background/50 border-white/10"
                        required 
                      />
                    </div>
                  </CardContent>
                  <CardFooter>
                    <Button 
                      type="submit" 
                      className="w-full bg-primary text-primary-foreground hover:bg-primary/90"
                      disabled={loginMutation.isPending}
                    >
                      {loginMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                      Sign In
                    </Button>
                  </CardFooter>
                </form>
              </Card>
            </TabsContent>
            
            <TabsContent value="register">
              <Card className="border-white/10 bg-card/50 backdrop-blur-sm">
                <form onSubmit={handleRegister}>
                  <CardHeader>
                    <CardTitle>Create Account</CardTitle>
                    <CardDescription>Join in seconds with just one identifier.</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="space-y-1.5">
                      <Label htmlFor="reg-identifier">
                        Username, Phone, or Email <span className="text-primary">*</span>
                      </Label>
                      <Input 
                        id="reg-identifier" 
                        value={regIdentifier}
                        onChange={(e) => setRegIdentifier(e.target.value)}
                        placeholder="e.g. shadow_gamer, alex@example.com, or +919876543210"
                        className="bg-background/50 border-white/10"
                        required 
                      />
                      <p className="text-[11px] text-muted-foreground">
                        Only one is required. You can use this to sign in later.
                      </p>
                    </div>

                    <div className="space-y-1.5">
                      <Label htmlFor="reg-password">Password <span className="text-primary">*</span></Label>
                      <Input 
                        id="reg-password" 
                        type="password" 
                        value={regPassword}
                        onChange={(e) => setRegPassword(e.target.value)}
                        placeholder="At least 6 characters"
                        className="bg-background/50 border-white/10"
                        required 
                        minLength={6}
                      />
                    </div>

                    {showOptionalName ? (
                      <div className="space-y-1.5 pt-1">
                        <div className="flex items-center justify-between">
                          <Label htmlFor="reg-fullname">Full Name (Optional)</Label>
                          <button
                            type="button"
                            onClick={() => setShowOptionalName(false)}
                            className="text-[11px] text-muted-foreground hover:text-white"
                          >
                            Hide
                          </button>
                        </div>
                        <Input 
                          id="reg-fullname" 
                          value={regFullName}
                          onChange={(e) => setRegFullName(e.target.value)}
                          placeholder="e.g. Alex Chen"
                          className="bg-background/50 border-white/10"
                        />
                      </div>
                    ) : (
                      <div className="pt-0.5">
                        <button
                          type="button"
                          onClick={() => setShowOptionalName(true)}
                          className="text-xs text-primary hover:underline font-medium cursor-pointer"
                        >
                          + Add full name (optional)
                        </button>
                      </div>
                    )}
                  </CardContent>
                  <CardFooter>
                    <Button 
                      type="submit" 
                      className="w-full bg-secondary text-white hover:bg-secondary/90 font-medium"
                      disabled={registerMutation.isPending}
                    >
                      {registerMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                      Create Account
                    </Button>
                  </CardFooter>
                </form>
              </Card>
            </TabsContent>
          </Tabs>
        </div>
      </div>

      {/* Right Side - Visual */}
      <div className="hidden lg:block relative overflow-hidden bg-black">
        <div className="absolute inset-0 bg-gradient-to-t from-background via-transparent to-transparent z-10" />
        {/* Abstract shapes or image */}
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-primary/20 rounded-full blur-[100px] animate-pulse" />
        <div className="absolute top-1/4 right-1/4 w-[400px] h-[400px] bg-secondary/20 rounded-full blur-[80px]" />
        
        <div className="relative z-20 h-full flex flex-col justify-center px-20">
          <blockquote className="space-y-2">
            <p className="text-lg font-light italic text-white/80">
              &ldquo;The interface is seamless, the rigs are powerful, and the vibe is unmatched. Play N' Slay is my second home.&rdquo;
            </p>
            <footer className="text-sm text-primary font-bold">Alex "Glitch" Chen, Pro Player</footer>
          </blockquote>
        </div>
      </div>

      {/* Forgot Password Dialog */}
      <Dialog open={isForgotPasswordOpen} onOpenChange={setIsForgotPasswordOpen}>
        <DialogContent className="bg-card border-white/10 sm:max-w-md">
          <DialogHeader>
            <div className="flex items-center gap-2 mb-1">
              <KeyRound className="w-5 h-5 text-primary" />
              <DialogTitle className="font-display">RESET PASSWORD</DialogTitle>
            </div>
            <DialogDescription>
              Enter the email address registered with your account. We will send you a secure link to reset your password.
            </DialogDescription>
          </DialogHeader>

          {forgotSuccessMessage ? (
            <div className="py-4 space-y-4 text-center">
              <div className="w-12 h-12 rounded-full bg-emerald-500/20 text-emerald-400 mx-auto flex items-center justify-center border border-emerald-500/30">
                <CheckCircle2 className="w-6 h-6" />
              </div>
              <p className="text-sm text-muted-foreground">{forgotSuccessMessage}</p>
              <Button
                type="button"
                onClick={() => setIsForgotPasswordOpen(false)}
                className="w-full bg-primary text-primary-foreground"
              >
                Done
              </Button>
            </div>
          ) : (
            <form onSubmit={handleForgotPassword} className="space-y-4 pt-2">
              <div className="space-y-2">
                <Label htmlFor="forgot-email">Account Email Address</Label>
                <div className="relative">
                  <Mail className="w-4 h-4 text-muted-foreground absolute left-3 top-3" />
                  <Input
                    id="forgot-email"
                    type="email"
                    placeholder="you@example.com"
                    value={forgotEmail}
                    onChange={(e) => setForgotEmail(e.target.value)}
                    required
                    disabled={isForgotSubmitting}
                    className="pl-9 bg-background/50 border-white/10"
                  />
                </div>
              </div>

              <DialogFooter className="gap-2 sm:gap-0 pt-2">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setIsForgotPasswordOpen(false)}
                  disabled={isForgotSubmitting}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={isForgotSubmitting}
                  className="bg-primary text-primary-foreground font-bold hover:bg-primary/90"
                >
                  {isForgotSubmitting ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Sending Instructions...
                    </>
                  ) : (
                    "Send Reset Link"
                  )}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

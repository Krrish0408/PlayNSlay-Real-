import { useState, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { KeyRound, Loader2, CheckCircle2, AlertCircle, ArrowLeft } from "lucide-react";
import logoImg from "@assets/PLAY_N_SLAY_LOGO__1768593233107.jpeg";

export default function ResetPasswordPage() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  const [token, setToken] = useState<string>("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const urlToken = params.get("token");
    if (urlToken) {
      setToken(urlToken.trim());
    } else {
      setErrorMessage("No password reset token was found in the link. Please request a new password reset link.");
    }
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);

    if (!token) {
      setErrorMessage("Missing password reset token.");
      return;
    }

    if (newPassword.length < 6) {
      setErrorMessage("Password must be at least 6 characters long.");
      return;
    }

    if (newPassword !== confirmPassword) {
      setErrorMessage("Passwords do not match.");
      return;
    }

    setIsSubmitting(true);
    try {
      const res = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          newPassword,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.message || "Failed to reset password. The link may have expired.");
      }

      setIsSuccess(true);
      toast({
        title: "Password Reset Successful",
        description: "Your password has been securely updated. You can now log in.",
      });
    } catch (err: any) {
      setErrorMessage(err.message || "Failed to reset password. Please try again or request a new reset link.");
      toast({
        title: "Reset Failed",
        description: err.message || "Unable to reset password.",
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-background flex flex-col justify-center items-center p-4 relative overflow-hidden">
      {/* Background glow effects */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[500px] h-[500px] bg-primary/10 rounded-full blur-[100px] pointer-events-none" />
      <div className="absolute top-1/4 right-1/4 w-[350px] h-[350px] bg-secondary/10 rounded-full blur-[90px] pointer-events-none" />

      <div className="w-full max-w-md space-y-6 relative z-10">
        {/* Header Branding */}
        <div className="text-center">
          <Link href="/">
            <div className="inline-flex items-center gap-2 mb-4 group cursor-pointer">
              <div className="w-12 h-12 rounded-xl border border-primary/40 overflow-hidden shadow-[0_0_15px_rgba(0,243,255,0.3)]">
                <img src={logoImg} alt="Play N' Slay" className="w-full h-full object-cover" />
              </div>
              <span className="font-display font-black text-xl tracking-wider">
                PLAY N'<span className="text-primary">SLAY</span>
              </span>
            </div>
          </Link>
          <h1 className="text-2xl sm:text-3xl font-display font-bold tracking-tight">Security Access Recovery</h1>
          <p className="text-sm text-muted-foreground mt-1">Configure your new credentials to regain grid access.</p>
        </div>

        <Card className="border-white/10 bg-card/60 backdrop-blur-md shadow-2xl">
          {isSuccess ? (
            <CardContent className="pt-8 pb-8 text-center space-y-4">
              <div className="w-16 h-16 rounded-full bg-emerald-500/20 text-emerald-400 mx-auto flex items-center justify-center border border-emerald-500/30">
                <CheckCircle2 className="w-8 h-8" />
              </div>
              <h2 className="text-xl font-bold font-display">PASSWORD UPDATED</h2>
              <p className="text-sm text-muted-foreground">
                Your new security password is active and all prior sessions have been securely terminated.
              </p>
              <div className="pt-4">
                <Button
                  onClick={() => setLocation("/auth")}
                  className="w-full bg-primary text-primary-foreground font-bold hover:bg-primary/90 h-11"
                >
                  Proceed to Login
                </Button>
              </div>
            </CardContent>
          ) : (
            <form onSubmit={handleSubmit}>
              <CardHeader>
                <div className="flex items-center gap-2 mb-1">
                  <KeyRound className="w-5 h-5 text-primary" />
                  <CardTitle className="text-lg">Set New Password</CardTitle>
                </div>
                <CardDescription>Enter a strong password with a minimum of 6 characters.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {errorMessage && (
                  <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm flex items-start gap-2.5">
                    <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                    <span>{errorMessage}</span>
                  </div>
                )}

                <div className="space-y-2">
                  <Label htmlFor="new-password">New Password</Label>
                  <Input
                    id="new-password"
                    type="password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="••••••••"
                    required
                    minLength={6}
                    disabled={isSubmitting || !token}
                    className="bg-background/50 border-white/10"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="confirm-password">Confirm New Password</Label>
                  <Input
                    id="confirm-password"
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="••••••••"
                    required
                    minLength={6}
                    disabled={isSubmitting || !token}
                    className="bg-background/50 border-white/10"
                  />
                </div>
              </CardContent>
              <CardFooter className="flex flex-col gap-3">
                <Button
                  type="submit"
                  disabled={isSubmitting || !token}
                  className="w-full bg-primary text-primary-foreground font-bold hover:bg-primary/90 h-11"
                >
                  {isSubmitting ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Updating Security Credentials...
                    </>
                  ) : (
                    "Reset Password"
                  )}
                </Button>
                <Link href="/auth" className="w-full">
                  <Button variant="ghost" type="button" className="w-full text-muted-foreground hover:text-foreground text-xs gap-1.5">
                    <ArrowLeft className="w-3.5 h-3.5" />
                    Back to Login
                  </Button>
                </Link>
              </CardFooter>
            </form>
          )}
        </Card>
      </div>
    </div>
  );
}

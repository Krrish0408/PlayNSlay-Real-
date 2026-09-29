"use client";

import { useState, useEffect } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Label } from "@/components/ui/label";
import { Loader2, Gamepad2 } from "lucide-react";

export default function AuthPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const { loginMutation, registerMutation, user, isLoading } = useAuth();
  const router = useRouter();

  // Redirect if already logged in
  useEffect(() => {
    if (user) {
      if (user.role === "employee") {
        router.replace("/employee");
      } else if (user.role === "admin") {
        router.replace("/admin");
      } else {
        router.replace("/dashboard");
      }
    }
  }, [user, router]);

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    loginMutation.mutate({ username, password });
  };

  const handleRegister = (e: React.FormEvent) => {
    e.preventDefault();
    registerMutation.mutate({ username, password });
  };

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-10 h-10 text-primary animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen grid lg:grid-cols-2 bg-background">
      {/* Left Side - Form */}
      <div className="flex items-center justify-center p-8">
        <div className="w-full max-w-md space-y-8">
          <div className="text-center mb-8">
            <div className="inline-flex p-3 rounded-2xl bg-primary/10 mb-4 border border-primary/20">
              <Gamepad2 className="w-10 h-10 text-primary" />
            </div>
            <h1 className="text-3xl font-display font-bold tracking-tight">Play N&apos; Slay</h1>
            <p className="text-muted-foreground mt-2">Enter the arena to continue.</p>
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
                    <CardTitle>Sign In</CardTitle>
                    <CardDescription>Access your account, reservations, and profile.</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="username">Username / Email</Label>
                      <Input
                        id="username"
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        className="bg-background/50 border-white/10"
                        placeholder="e.g. gamer@nexus.gg"
                        required
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="password">Password</Label>
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
                      Authorize Entry
                    </Button>
                  </CardFooter>
                </form>
              </Card>
            </TabsContent>

            <TabsContent value="register">
              <Card className="border-white/10 bg-card/50 backdrop-blur-sm">
                <form onSubmit={handleRegister}>
                  <CardHeader>
                    <CardTitle>Create Member Account</CardTitle>
                    <CardDescription>Join the elite gaming community.</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="reg-username">Username / Email</Label>
                      <Input
                        id="reg-username"
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        className="bg-background/50 border-white/10"
                        required
                        minLength={3}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="reg-password">Password (min 6 characters)</Label>
                      <Input
                        id="reg-password"
                        type="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        className="bg-background/50 border-white/10"
                        required
                        minLength={6}
                      />
                    </div>
                  </CardContent>
                  <CardFooter>
                    <Button
                      type="submit"
                      className="w-full bg-secondary text-white hover:bg-secondary/90"
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
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-primary/20 rounded-full blur-[100px] animate-pulse" />
        <div className="absolute top-1/4 right-1/4 w-[400px] h-[400px] bg-secondary/20 rounded-full blur-[80px]" />

        <div className="relative z-20 h-full flex flex-col justify-center px-20">
          <blockquote className="space-y-2">
            <p className="text-lg font-light italic text-white/80">
              &ldquo;The interface is seamless, the rigs are powerful, and the vibe is unmatched. Play N&apos; Slay is our team&apos;s primary arena.&rdquo;
            </p>
            <footer className="text-sm text-primary font-bold">Alex &ldquo;Glitch&rdquo; Chen, Pro Player</footer>
          </blockquote>
        </div>
      </div>
    </div>
  );
}

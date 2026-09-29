"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import type { InsertUser } from "@/shared/schema";
import { signIn, signOut } from "next-auth/react";

export function useAuth() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const {
    data: user,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["/api/auth/user"],
    queryFn: async () => {
      const res = await fetch("/api/auth/user", { credentials: "include" });
      if (res.status === 401) return null;
      if (!res.ok) throw new Error("Failed to fetch session");
      return await res.json();
    },
    retry: false,
    staleTime: 1000 * 30, // 30 seconds
  });

  const loginMutation = useMutation({
    mutationFn: async (credentials: { username: string; password: string }) => {
      const res = await signIn("credentials", {
        username: credentials.username,
        password: credentials.password,
        redirect: false,
      });

      if (res?.error) {
        throw new Error("Invalid username or password");
      }

      // Fetch fresh user data
      const userRes = await fetch("/api/auth/user", { credentials: "include" });
      if (!userRes.ok) throw new Error("Failed to retrieve user after login");
      return await userRes.json();
    },
    onSuccess: (data) => {
      queryClient.setQueryData(["/api/auth/user"], data);
      toast({
        title: "⚡ Welcome Back",
        description: `Authenticated as ${data.username}`,
        className: "border-primary/50 text-foreground",
      });
    },
    onError: (err: Error) => {
      toast({
        title: "Login Failed",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const registerMutation = useMutation({
    mutationFn: async (data: InsertUser) => {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({ message: "Registration failed" }));
        throw new Error(errorData.message || "Registration failed");
      }

      const createdUser = await res.json();

      // Auto login with credentials
      const loginRes = await signIn("credentials", {
        username: data.username,
        password: data.password,
        redirect: false,
      });

      if (loginRes?.error) {
        throw new Error("Registration succeeded but automatic login failed. Please sign in manually.");
      }

      const userRes = await fetch("/api/auth/user", { credentials: "include" });
      if (userRes.ok) {
        return await userRes.json();
      }
      return createdUser;
    },
    onSuccess: (data) => {
      queryClient.setQueryData(["/api/auth/user"], data);
      toast({
        title: "✅ Account Created",
        description: `Welcome to Play N' Slay, ${data.username}!`,
      });
    },
    onError: (err: Error) => {
      toast({
        title: "Registration Error",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const logoutMutation = useMutation({
    mutationFn: async () => {
      await signOut({ redirect: false });
    },
    onSuccess: () => {
      queryClient.setQueryData(["/api/auth/user"], null);
      queryClient.invalidateQueries();
      toast({
        title: "Session Terminated",
        description: "You have been logged out securely.",
      });
    },
  });

  return {
    user,
    isLoading,
    error,
    loginMutation,
    registerMutation,
    logoutMutation,
  };
}

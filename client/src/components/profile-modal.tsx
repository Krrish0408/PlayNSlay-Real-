import React, { useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { ImageUpload } from "@/components/image-upload";
import { User, Lock, Shield, Check, Loader2, Sparkles, Download, Trash2, ShieldCheck, AlertTriangle } from "lucide-react";
import { queryClient } from "@/lib/queryClient";

interface ProfileModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ProfileModal({ open, onOpenChange }: ProfileModalProps) {
  const { user, logoutMutation } = useAuth();
  const { toast } = useToast();

  // Profile Form State
  const [fullName, setFullName] = useState(user?.fullName || "");
  const [phone, setPhone] = useState(user?.phone || "");
  const [avatarUrl, setAvatarUrl] = useState(user?.avatarUrl || "");
  const [isUpdatingProfile, setIsUpdatingProfile] = useState(false);

  // Password Form State
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isChangingPassword, setIsChangingPassword] = useState(false);

  // Privacy State
  const [isExporting, setIsExporting] = useState(false);
  const [isDeletingAccount, setIsDeletingAccount] = useState(false);
  const [deletePassword, setDeletePassword] = useState("");
  const [confirmDeleteChecked, setConfirmDeleteChecked] = useState(false);

  // Update initial fields when modal opens
  React.useEffect(() => {
    if (user && open) {
      setFullName(user.fullName || "");
      setPhone(user.phone || "");
      setAvatarUrl(user.avatarUrl || "");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setDeletePassword("");
      setConfirmDeleteChecked(false);
    }
  }, [user, open]);

  const handleExportData = async () => {
    try {
      setIsExporting(true);
      const res = await fetch("/api/user/privacy/export");
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || "Failed to export personal data");
      }
      const data = await res.json();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `play_n_slay_privacy_export_${user?.id || "data"}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      toast({
        title: "Export Generated 📦",
        description: "Your personal data archive has been downloaded.",
      });
    } catch (err: any) {
      toast({
        title: "Export Failed",
        description: err.message || "Could not generate data export.",
        variant: "destructive",
      });
    } finally {
      setIsExporting(false);
    }
  };

  const handleDeleteAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!confirmDeleteChecked) {
      toast({
        title: "Confirmation Required",
        description: "Please check the box to confirm you understand account deletion.",
        variant: "destructive",
      });
      return;
    }

    if (user?.authProvider === "local" && !deletePassword) {
      toast({
        title: "Password Required",
        description: "Please enter your password to authorize account deletion.",
        variant: "destructive",
      });
      return;
    }

    try {
      setIsDeletingAccount(true);
      const res = await fetch("/api/user/privacy/delete-request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          password: deletePassword,
          confirm: true,
          reason: "User requested deletion via Profile Modal",
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || "Failed to delete account");
      }

      toast({
        title: "Account Anonymized & Deleted",
        description: "Your personal data has been erased and anonymized.",
      });

      onOpenChange(false);
      window.location.href = "/";
    } catch (err: any) {
      toast({
        title: "Deletion Failed",
        description: err.message || "Could not delete account.",
        variant: "destructive",
      });
    } finally {
      setIsDeletingAccount(false);
    }
  };

  const handleUpdateProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setIsUpdatingProfile(true);
      const res = await fetch("/api/user/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fullName, phone, avatarUrl }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Failed to update profile");
      }

      await queryClient.invalidateQueries({ queryKey: ["/api/user"] });
      toast({
        title: "Profile Updated ✨",
        description: "Your details have been saved successfully.",
      });
      onOpenChange(false);
    } catch (err: any) {
      toast({
        title: "Update Failed",
        description: err.message || "Could not update profile.",
        variant: "destructive",
      });
    } finally {
      setIsUpdatingProfile(false);
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      toast({
        title: "Passwords Don't Match",
        description: "New password and confirmation do not match.",
        variant: "destructive",
      });
      return;
    }

    if (newPassword.length < 6) {
      toast({
        title: "Password Too Short",
        description: "New password must be at least 6 characters.",
        variant: "destructive",
      });
      return;
    }

    try {
      setIsChangingPassword(true);
      const res = await fetch("/api/user/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || "Failed to change password");
      }

      toast({
        title: "Password Changed 🔒",
        description: "Your password has been updated securely.",
      });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      onOpenChange(false);
    } catch (err: any) {
      toast({
        title: "Password Change Failed",
        description: err.message || "Could not change password.",
        variant: "destructive",
      });
    } finally {
      setIsChangingPassword(false);
    }
  };

  if (!user) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-card border-white/10 max-w-lg">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-primary/10 border border-primary/20 text-primary">
              <User className="w-5 h-5" />
            </div>
            <div>
              <DialogTitle className="text-xl font-bold font-display">Account & Profile Settings</DialogTitle>
              <DialogDescription className="text-xs text-muted-foreground">
                Manage your gamer profile, avatar photo, and security.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {/* User Card Overview */}
        <div className="p-3.5 rounded-lg border border-white/10 bg-background/50 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-full overflow-hidden border border-primary/40 bg-background flex items-center justify-center text-primary font-bold">
              {avatarUrl ? (
                <img src={avatarUrl} alt="Avatar" className="w-full h-full object-cover" />
              ) : (
                user.username.substring(0, 2).toUpperCase()
              )}
            </div>
            <div>
              <h4 className="font-semibold text-sm flex items-center gap-2">
                {fullName || user.username}
                <Badge variant="outline" className="text-[10px] uppercase border-primary/30 text-primary bg-primary/10">
                  {user.role}
                </Badge>
              </h4>
              <p className="text-xs text-muted-foreground">@{user.username} {user.email ? `• ${user.email}` : ""}</p>
            </div>
          </div>
          <div className="text-right">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground block">Tier</span>
            <span className="text-xs font-semibold text-primary capitalize flex items-center gap-1">
              <Sparkles className="w-3 h-3" />
              {user.membershipTier || "Bronze"}
            </span>
          </div>
        </div>

        <Tabs defaultValue="profile" className="w-full mt-2">
          <TabsList className="grid grid-cols-3 bg-background/50 border border-white/10">
            <TabsTrigger value="profile" className="gap-1.5 text-xs">
              <User className="w-3.5 h-3.5" />
              Profile
            </TabsTrigger>
            <TabsTrigger value="security" className="gap-1.5 text-xs">
              <Lock className="w-3.5 h-3.5" />
              Password
            </TabsTrigger>
            <TabsTrigger value="privacy" className="gap-1.5 text-xs">
              <ShieldCheck className="w-3.5 h-3.5" />
              Privacy & Data
            </TabsTrigger>
          </TabsList>

          {/* Profile Tab */}
          <TabsContent value="profile" className="space-y-4 pt-3">
            <form onSubmit={handleUpdateProfile} className="space-y-4">
              <div>
                <Label className="text-xs">Full Name</Label>
                <Input
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder="e.g. Krrish Jain"
                  className="bg-background/50 border-white/10 text-sm mt-1"
                />
              </div>

              <div>
                <Label className="text-xs">Phone Number</Label>
                <Input
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="+91 98765 43210"
                  className="bg-background/50 border-white/10 text-sm mt-1"
                />
              </div>

              <ImageUpload
                label="Profile Avatar (Cloudinary)"
                value={avatarUrl}
                onChange={setAvatarUrl}
              />

              <Button
                type="submit"
                disabled={isUpdatingProfile}
                className="w-full bg-primary text-primary-foreground gap-2 font-medium"
              >
                {isUpdatingProfile ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Saving Profile...
                  </>
                ) : (
                  <>
                    <Check className="w-4 h-4" />
                    Save Profile Changes
                  </>
                )}
              </Button>
            </form>
          </TabsContent>

          {/* Security Tab */}
          <TabsContent value="security" className="space-y-4 pt-3">
            <form onSubmit={handleChangePassword} className="space-y-3.5">
              <div>
                <Label className="text-xs">Current Password</Label>
                <Input
                  type="password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  required
                  placeholder="••••••••"
                  className="bg-background/50 border-white/10 text-sm mt-1"
                />
              </div>

              <div>
                <Label className="text-xs">New Password (min 6 characters)</Label>
                <Input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  required
                  minLength={6}
                  placeholder="••••••••"
                  className="bg-background/50 border-white/10 text-sm mt-1"
                />
              </div>

              <div>
                <Label className="text-xs">Confirm New Password</Label>
                <Input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                  placeholder="••••••••"
                  className="bg-background/50 border-white/10 text-sm mt-1"
                />
              </div>

              <Button
                type="submit"
                disabled={isChangingPassword}
                className="w-full bg-primary text-primary-foreground gap-2 font-medium mt-2"
              >
                {isChangingPassword ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Updating Password...
                  </>
                ) : (
                  <>
                    <Shield className="w-4 h-4" />
                    Update Password
                  </>
                )}
              </Button>
            </form>
          </TabsContent>

          {/* Privacy & Data Tab */}
          <TabsContent value="privacy" className="space-y-4 pt-3">
            {/* Export Section */}
            <div className="p-3.5 rounded-lg border border-white/10 bg-background/50 space-y-2">
              <div className="flex items-center justify-between">
                <div>
                  <h4 className="text-xs font-bold text-foreground flex items-center gap-1.5">
                    <Download className="w-3.5 h-3.5 text-primary" />
                    Export Personal Data (GDPR)
                  </h4>
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    Download all your profile details, session metadata, and booking records in JSON format.
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleExportData}
                  disabled={isExporting}
                  className="border-primary/40 text-primary hover:bg-primary/10 text-xs shrink-0 ml-2"
                >
                  {isExporting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Download"}
                </Button>
              </div>
            </div>

            {/* Account Deletion Section */}
            <div className="p-3.5 rounded-lg border border-red-500/20 bg-red-500/5 space-y-3">
              <div>
                <h4 className="text-xs font-bold text-red-400 flex items-center gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5" />
                  Account Deletion & Anonymization
                </h4>
                <p className="text-[11px] text-muted-foreground mt-1">
                  Permanently erases all personal identifiers (email, phone, name, avatar).
                  Legally required financial transaction records are retained anonymously for 7-year tax compliance.
                </p>
              </div>

              <form onSubmit={handleDeleteAccount} className="space-y-3 pt-1 border-t border-white/5">
                <label className="flex items-start gap-2 cursor-pointer text-[11px] text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={confirmDeleteChecked}
                    onChange={(e) => setConfirmDeleteChecked(e.target.checked)}
                    className="mt-0.5 rounded border-white/20 bg-background"
                  />
                  <span>I understand my personal account will be erased and cannot be recovered.</span>
                </label>

                {user.authProvider === "local" && (
                  <div>
                    <Label className="text-[11px] text-muted-foreground">Confirm Password</Label>
                    <Input
                      type="password"
                      value={deletePassword}
                      onChange={(e) => setDeletePassword(e.target.value)}
                      placeholder="Enter your current password"
                      className="bg-background/50 border-white/10 text-xs mt-1"
                    />
                  </div>
                )}

                <Button
                  type="submit"
                  variant="destructive"
                  size="sm"
                  disabled={isDeletingAccount || !confirmDeleteChecked}
                  className="w-full gap-2 text-xs"
                >
                  {isDeletingAccount ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      Anonymizing & Deleting...
                    </>
                  ) : (
                    <>
                      <Trash2 className="w-3.5 h-3.5" />
                      Permanently Delete & Anonymize Account
                    </>
                  )}
                </Button>
              </form>
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

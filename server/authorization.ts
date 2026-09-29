import type { Request, Response, NextFunction } from "express";
import type { User, Booking, Permission } from "@shared/schema";
import { hasPermission } from "@shared/schema";
import { config } from "./config";

/**
 * Role predicates - derived strictly from authoritative 'role' column.
 * Never checks conflicting fields.
 */
export function isAdmin(user?: User | null): boolean {
  if (!user) return false;
  return user.role === "admin";
}

export function isEmployee(user?: User | null): boolean {
  if (!user) return false;
  return user.role === "employee";
}

export function isStaff(user?: User | null): boolean {
  if (!user) return false;
  return user.role === "admin" || user.role === "employee";
}

export function isMember(user?: User | null): boolean {
  if (!user) return false;
  return user.role === "member";
}

/**
 * MFA Verification Helper
 */
export function checkMfaEnforced(req: Request, res: Response): boolean {
  const user = req.user as User | undefined;
  if (!user) return true;

  // If MFA is enabled on the account, verification is strictly required for all sessions
  if (user.isMfaEnabled && !(req.session as any)?.mfaVerified) {
    res.status(403).json({
      message: "MFA verification required.",
      code: "MFA_REQUIRED",
      mfaRequired: true,
    });
    return false;
  }

  // If staff MFA enforcement is active, staff accounts MUST have MFA configured
  const enforceStaffMfa = config.auth?.enforceStaffMfa ?? (process.env.NODE_ENV === "production");
  if (enforceStaffMfa && isStaff(user) && !user.isMfaEnabled) {
    const mfaOnboardingPaths = [
      "/api/auth/mfa/setup",
      "/api/auth/mfa/activate",
      "/api/auth/mfa/status",
      "/api/user",
      "/api/logout",
      "/api/csrf-token",
    ];
    if (!mfaOnboardingPaths.includes(req.path)) {
      res.status(403).json({
        message: "MFA setup is required for administrator and employee accounts. Please complete two-factor authentication setup.",
        code: "MFA_SETUP_REQUIRED",
        mfaSetupRequired: true,
      });
      return false;
    }
  }

  return true;
}

/**
 * Authentication and Permission Middlewares
 * Enforce DENY BY DEFAULT.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.isAuthenticated || !req.isAuthenticated() || !req.user) {
    return res.status(401).json({ message: "Authentication required" });
  }
  if (!checkMfaEnforced(req, res)) return;
  next();
}

export function requirePermission(permission: Permission) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.isAuthenticated || !req.isAuthenticated() || !req.user) {
      return res.status(401).json({ message: "Authentication required" });
    }
    if (!checkMfaEnforced(req, res)) return;

    const user = req.user as User;
    if (!hasPermission(user, permission)) {
      return res.status(403).json({
        message: `Forbidden: missing permission ${permission}`,
        code: "PERMISSION_DENIED",
        permission,
      });
    }
    next();
  };
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.isAuthenticated || !req.isAuthenticated() || !req.user) {
    return res.status(401).json({ message: "Authentication required" });
  }
  if (!checkMfaEnforced(req, res)) return;
  if (!isAdmin(req.user as User)) {
    return res.status(403).json({ message: "Admin access required" });
  }
  next();
}

export function requireStaff(req: Request, res: Response, next: NextFunction) {
  if (!req.isAuthenticated || !req.isAuthenticated() || !req.user) {
    return res.status(401).json({ message: "Authentication required" });
  }
  if (!checkMfaEnforced(req, res)) return;
  if (!isStaff(req.user as User)) {
    return res.status(403).json({ message: "Staff access required" });
  }
  next();
}

/**
 * Email Verification Policy Middleware
 *
 * Defines feature gates for member accounts:
 * - Members MUST have a verified email (is_email_verified = true) to reserve stations
 *   (create online bookings), cancel bookings, or modify security credentials.
 * - Unverified members can browse catalog games, check availability, view their profile,
 *   and request verification links.
 * - Staff (Admins and Employees) are operational accounts and exempt from member gates.
 */
export function requireVerifiedEmail(req: Request, res: Response, next: NextFunction) {
  if (!req.isAuthenticated || !req.isAuthenticated() || !req.user) {
    return res.status(401).json({ message: "Authentication required" });
  }

  const user = req.user as User;

  // Staff are operational and exempt
  if (isStaff(user)) {
    return next();
  }

  // Members must have verified email
  if (!user.isEmailVerified) {
    return res.status(403).json({
      message: "Email verification required. Please verify your email before booking.",
      code: "EMAIL_VERIFICATION_REQUIRED",
    });
  }

  next();
}

/**
 * Booking Resource Authorization Policy (Centralized Permissions & Deny-by-default)
 */
export const BookingPolicy = {
  canRead(currentUser: User, booking: Booking): boolean {
    if (hasPermission(currentUser, "BOOKING_READ_ALL")) return true;
    if (hasPermission(currentUser, "BOOKING_READ_OWN")) {
      return booking.userId === currentUser.id;
    }
    return false;
  },

  canCancel(currentUser: User, booking: Booking): { allowed: boolean; status: number; reason?: string } {
    if (hasPermission(currentUser, "BOOKING_MANAGE")) {
      if (booking.status === "Cancelled") {
        return { allowed: false, status: 400, reason: "Booking is already cancelled" };
      }
      return { allowed: true, status: 200 };
    }

    // Member can only cancel their own bookings
    if (booking.userId !== currentUser.id) {
      return { allowed: false, status: 403, reason: "You are not authorized to cancel this booking" };
    }

    if (!hasPermission(currentUser, "BOOKING_CANCEL_OWN")) {
      return { allowed: false, status: 403, reason: "You do not have permission to cancel bookings" };
    }

    // Eligible statuses for member cancellation: Pending, Approved
    const eligibleStatuses = ["Pending", "Approved"];
    if (!eligibleStatuses.includes(booking.status)) {
      return { allowed: false, status: 400, reason: `Booking with status '${booking.status}' cannot be cancelled` };
    }

    return { allowed: true, status: 200 };
  },

  canUpdateStatus(currentUser: User, booking: Booking, newStatus: string): { allowed: boolean; status: number; reason?: string } {
    if (hasPermission(currentUser, "BOOKING_MANAGE")) {
      return { allowed: true, status: 200 };
    }

    // Member horizontal escalation attempt: modifying someone else's booking
    if (booking.userId !== currentUser.id) {
      return { allowed: false, status: 403, reason: "You are not authorized to modify this booking" };
    }

    // Member vertical escalation attempt: modifying booking status to non-cancellation
    if (newStatus !== "Cancelled") {
      return { allowed: false, status: 403, reason: "Members are only permitted to cancel eligible bookings" };
    }

    return this.canCancel(currentUser, booking);
  },

  canOperateTimer(currentUser: User): boolean {
    return hasPermission(currentUser, "BOOKING_MANAGE");
  },

  canCreateOffline(currentUser: User): boolean {
    return hasPermission(currentUser, "BOOKING_MANAGE");
  },
};

/**
 * User Resource Authorization Policy
 */
export const UserPolicy = {
  canReadProfile(currentUser: User, targetUserId: number): boolean {
    if (hasPermission(currentUser, "USER_VIEW_ALL")) return true;
    if (hasPermission(currentUser, "USER_READ_OWN")) {
      return currentUser.id === targetUserId;
    }
    return false;
  },

  canResetPassword(currentUser: User, targetUser?: User | null): boolean {
    return hasPermission(currentUser, "USER_MANAGE");
  },

  canManageAdmin(currentUser: User, targetUser: User): boolean {
    // Only administrators with USER_MANAGE can manage admins
    return hasPermission(currentUser, "USER_MANAGE") && isAdmin(currentUser);
  },

  canModifyRole(currentUser: User): boolean {
    return hasPermission(currentUser, "USER_MANAGE");
  },
};

/**
 * Employee Data Authorization Policy
 */
export const EmployeeDataPolicy = {
  canAccessStats(currentUser: User, targetEmployeeId?: number): boolean {
    if (hasPermission(currentUser, "ANALYTICS_VIEW")) return true;
    if (hasPermission(currentUser, "EMPLOYEE_STATS_VIEW_OWN")) {
      if (targetEmployeeId !== undefined && targetEmployeeId !== null) {
        return currentUser.id === targetEmployeeId;
      }
      return true;
    }
    return false;
  },
};

/**
 * Station Resource Authorization Policy
 */
export const StationPolicy = {
  canCreate(currentUser: User): boolean {
    return hasPermission(currentUser, "STATION_MANAGE");
  },
  canDelete(currentUser: User): boolean {
    return hasPermission(currentUser, "STATION_MANAGE");
  },
  canUpdateOperational(currentUser: User): boolean {
    return hasPermission(currentUser, "BOOKING_MANAGE") || hasPermission(currentUser, "STATION_MANAGE");
  },
};

/**
 * Game Catalog Resource Authorization Policy
 */
export const CatalogPolicy = {
  canManage(currentUser: User): boolean {
    return hasPermission(currentUser, "CATALOG_MANAGE");
  },
};


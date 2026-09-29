# Play N' Slay Gaming Lounge

## Overview

Play N' Slay is a full-stack gaming lounge management and booking web application. It allows customers to book gaming stations with dynamic game types, automated price calculations, and time slot selection. The platform features a cyberpunk/neon aesthetic with role-based access for members, employees, and administrators.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend Architecture
- **Framework**: React 18 with TypeScript
- **Routing**: Wouter (lightweight router)
- **State Management**: TanStack React Query for server state
- **Styling**: Tailwind CSS with CSS variables for theming
- **UI Components**: shadcn/ui component library (New York style)
- **Animations**: Framer Motion for page transitions
- **Charts**: Recharts for admin analytics dashboard
- **Build Tool**: Vite with custom plugins for Replit integration

### Backend Architecture
- **Runtime**: Node.js with Express
- **Language**: TypeScript (ES Modules)
- **API Design**: REST API with typed routes defined in `shared/routes.ts`
- **Authentication**: Passport.js with Local Strategy, session-based auth
- **Session Storage**: PostgreSQL-backed sessions via connect-pg-simple

### Data Storage
- **Database**: PostgreSQL
- **ORM**: Drizzle ORM with drizzle-zod for schema validation
- **Schema Location**: `shared/schema.ts` (shared between client and server)
- **Migrations**: Drizzle Kit with `db:push` command

### Key Data Models
1. **Users**: Members, employees, and admins with role-based access
2. **GameTypes**: Configurable game stations with pricing, capacity, and images
3. **Bookings**: Time-slot reservations with status tracking and payment info

### Authentication & Authorization
- Session-based authentication using express-session
- Password hashing with scrypt and timing-safe comparison
- Role-based access control (member, employee, admin)
- Protected routes with `requireAdmin` middleware on server
- Client-side route protection with `ProtectedRoute` component

### Project Structure
```
├── client/           # React frontend
│   └── src/
│       ├── components/   # UI components
│       ├── hooks/        # Custom React hooks
│       ├── pages/        # Page components
│       └── lib/          # Utilities
├── server/           # Express backend
│   ├── auth.ts       # Authentication setup
│   ├── db.ts         # Database connection
│   ├── routes.ts     # API endpoints
│   └── storage.ts    # Data access layer
├── shared/           # Shared code
│   ├── schema.ts     # Database schema
│   └── routes.ts     # API route definitions
└── migrations/       # Database migrations
```

### Build & Development
- Development: `npm run dev` (Vite dev server + Express)
- Production build: `npm run build` (esbuild for server, Vite for client)
- Database sync: `npm run db:push`

## External Dependencies

### Database
- **PostgreSQL**: Primary database (connection via `DATABASE_URL` environment variable)
- **connect-pg-simple**: PostgreSQL session store

### Core Libraries
- **Drizzle ORM**: Type-safe database queries
- **Zod**: Runtime schema validation
- **date-fns**: Date manipulation for bookings

### UI Libraries
- **Radix UI**: Accessible component primitives
- **shadcn/ui**: Pre-styled component library
- **Recharts**: Analytics charts
- **Framer Motion**: Animations
- **Lucide React**: Icon library

### Environment Variables Required
- `DATABASE_URL`: PostgreSQL connection string
- `SESSION_SECRET`: Secret for session encryption (optional, has default)
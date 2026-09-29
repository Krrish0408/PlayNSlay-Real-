"use client";

import { Navbar } from "@/components/layout-navbar";
import { BookingWizard } from "@/components/booking-wizard";
import { motion } from "framer-motion";

export default function HomePage() {
  return (
    <div className="min-h-screen bg-background text-foreground overflow-x-hidden">
      <Navbar />

      {/* Hero Section */}
      <section className="relative pt-32 pb-20 px-4">
        {/* Background Elements */}
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[800px] h-[500px] bg-primary/10 blur-[100px] rounded-full pointer-events-none" />
        <div className="absolute top-20 right-0 w-[400px] h-[400px] bg-secondary/10 blur-[80px] rounded-full pointer-events-none" />

        <div className="container mx-auto text-center relative z-10">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8 }}
          >
            <div className="inline-block mb-6">
              <div className="w-24 h-24 mx-auto rounded-2xl border-2 border-primary shadow-[0_0_30px_rgba(0,243,255,0.3)] overflow-hidden">
                <img
                  src="/assets/PLAY_N_SLAY_LOGO__1768593233107.jpeg"
                  alt="Play N' Slay Logo"
                  className="h-full w-full object-cover"
                />
              </div>
            </div>
            <h1 className="text-5xl md:text-7xl font-display font-black mb-6 leading-tight tracking-tight">
              LEVEL UP YOUR <br />
              <span className="bg-clip-text text-transparent bg-gradient-to-r from-primary via-white to-secondary animate-gradient bg-[length:200%_auto]">
                GAMING EXPERIENCE
              </span>
            </h1>
            <p className="text-xl text-muted-foreground max-w-2xl mx-auto mb-12 font-light">
              Premium gaming stations, high-performance rigs, and an immersive atmosphere designed for champions. Book your station now.
            </p>
          </motion.div>

          <div id="booking-section">
            <BookingWizard />
          </div>
        </div>
      </section>

      {/* Features Grid */}
      <section className="py-20 bg-black/20 border-t border-white/5">
        <div className="container mx-auto px-4 grid grid-cols-1 md:grid-cols-3 gap-8">
          <div className="p-6 rounded-2xl bg-card/30 border border-white/5 hover:border-primary/30 transition-colors">
            <div className="w-12 h-12 rounded-lg bg-primary/10 flex items-center justify-center mb-4">
              <span className="text-2xl">🚀</span>
            </div>
            <h3 className="text-xl font-bold mb-2">RTX 4090 Stations</h3>
            <p className="text-muted-foreground">Top tier hardware for maximum FPS in competitive titles.</p>
          </div>
          <div className="p-6 rounded-2xl bg-card/30 border border-white/5 hover:border-secondary/30 transition-colors">
            <div className="w-12 h-12 rounded-lg bg-secondary/10 flex items-center justify-center mb-4">
              <span className="text-2xl">⚡</span>
            </div>
            <h3 className="text-xl font-bold mb-2">Gigabit Fiber</h3>
            <p className="text-muted-foreground">Zero-latency connection for the ultimate competitive edge.</p>
          </div>
          <div className="p-6 rounded-2xl bg-card/30 border border-white/5 hover:border-accent/30 transition-colors">
            <div className="w-12 h-12 rounded-lg bg-accent/10 flex items-center justify-center mb-4">
              <span className="text-2xl">🥤</span>
            </div>
            <h3 className="text-xl font-bold mb-2">Full Service Bar</h3>
            <p className="text-muted-foreground">Snacks and energy drinks delivered right to your station.</p>
          </div>
        </div>
      </section>
    </div>
  );
}

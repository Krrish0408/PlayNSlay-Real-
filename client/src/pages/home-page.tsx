import { Navbar } from "@/components/layout-navbar";
import { BookingWizard } from "@/components/booking-wizard";
import { motion } from "framer-motion";
import logoImg from "@assets/PLAY_N_SLAY_LOGO__1768593233107.jpeg";

export default function HomePage() {
  return (
    <div className="min-h-screen bg-background text-foreground overflow-x-hidden">
      <Navbar />
      
      {/* Hero Section */}
      <section className="relative pt-24 sm:pt-32 pb-12 sm:pb-20 px-3 sm:px-4">
        {/* Background Elements */}
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[340px] sm:w-[600px] md:w-[800px] h-[300px] sm:h-[500px] bg-primary/10 blur-[80px] sm:blur-[100px] rounded-full pointer-events-none" />
        <div className="absolute top-20 right-0 w-[240px] sm:w-[400px] h-[240px] sm:h-[400px] bg-secondary/10 blur-[60px] sm:blur-[80px] rounded-full pointer-events-none" />

        <div className="container mx-auto text-center relative z-10 max-w-5xl">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8 }}
          >
            <div className="inline-block mb-4 sm:mb-6">
              <div className="w-18 h-18 sm:w-24 sm:h-24 mx-auto rounded-2xl border-2 border-primary shadow-[0_0_30px_rgba(0,243,255,0.3)] overflow-hidden">
                <img src={logoImg} alt="Play N' Slay Logo" className="h-full w-full object-cover" />
              </div>
            </div>
            <h1 className="text-3xl sm:text-5xl md:text-7xl font-display font-black mb-4 sm:mb-6 leading-tight tracking-tight">
              LEVEL UP YOUR <br />
              <span className="bg-clip-text text-transparent bg-gradient-to-r from-primary via-white to-secondary animate-gradient bg-[length:200%_auto]">
                GAMING EXPERIENCE
              </span>
            </h1>
            <p className="text-sm sm:text-base md:text-xl text-muted-foreground max-w-2xl mx-auto mb-8 sm:mb-12 font-light px-2">
              Premium gaming stations, high-performance rigs, and an immersive atmosphere designed for champions. Book your station now.
            </p>
          </motion.div>

          <div id="booking-section">
            <BookingWizard />
          </div>
        </div>
      </section>

      {/* Games Catalog Teaser Banner */}
      <section className="py-8 sm:py-12 border-t border-white/5 bg-gradient-to-r from-primary/10 via-card/50 to-secondary/10 px-3 sm:px-4">
        <div className="container mx-auto max-w-5xl">
          <div className="flex flex-col md:flex-row items-center justify-between gap-6 p-5 sm:p-8 rounded-2xl bg-card/60 border border-primary/20 backdrop-blur-md shadow-[0_0_30px_rgba(0,243,255,0.1)]">
            <div className="space-y-2 text-center md:text-left">
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary/20 text-primary text-xs font-bold uppercase tracking-wider">
                🔥 38+ Titles Available
              </div>
              <h2 className="text-xl sm:text-2xl md:text-3xl font-display font-black tracking-tight">
                Want to browse all available games & stations?
              </h2>
              <p className="text-muted-foreground text-xs sm:text-sm max-w-xl">
                Check player capacities, genre lists, and compatible rigs across PS5, PS4, Racing Simulators, and VR Arenas.
              </p>
            </div>
            <a
              href="/games"
              className="w-full md:w-auto text-center inline-flex items-center justify-center gap-2 px-6 py-3 rounded-xl bg-primary text-primary-foreground font-bold hover:bg-primary/90 shadow-[0_0_20px_rgba(0,243,255,0.4)] transition-all hover:scale-105 shrink-0"
            >
              <span>Explore Games Catalog</span>
              <span>→</span>
            </a>
          </div>
        </div>
      </section>

      {/* Features Grid */}
      <section className="py-12 sm:py-20 bg-black/20 border-t border-white/5 px-3 sm:px-4">
        <div className="container mx-auto max-w-5xl grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4 sm:gap-6">
          <div className="p-5 sm:p-6 rounded-2xl bg-card/30 border border-white/5 hover:border-primary/30 transition-colors">
            <div className="w-12 h-12 rounded-lg bg-primary/10 flex items-center justify-center mb-4">
              <span className="text-2xl">🚀</span>
            </div>
            <h3 className="text-lg sm:text-xl font-bold mb-2">RTX 4090 Stations</h3>
            <p className="text-xs sm:text-sm text-muted-foreground">Top tier hardware for maximum FPS in competitive titles.</p>
          </div>
          <div className="p-5 sm:p-6 rounded-2xl bg-card/30 border border-white/5 hover:border-secondary/30 transition-colors">
             <div className="w-12 h-12 rounded-lg bg-secondary/10 flex items-center justify-center mb-4">
              <span className="text-2xl">⚡</span>
            </div>
            <h3 className="text-lg sm:text-xl font-bold mb-2">Gigabit Fiber</h3>
            <p className="text-xs sm:text-sm text-muted-foreground">Zero-latency connection for the ultimate competitive edge.</p>
          </div>
          <div className="p-5 sm:p-6 rounded-2xl bg-card/30 border border-white/5 hover:border-accent/30 transition-colors sm:col-span-2 md:col-span-1">
             <div className="w-12 h-12 rounded-lg bg-accent/10 flex items-center justify-center mb-4">
              <span className="text-2xl">🥤</span>
            </div>
            <h3 className="text-lg sm:text-xl font-bold mb-2">Full Service Bar</h3>
            <p className="text-xs sm:text-sm text-muted-foreground">Snacks and energy drinks delivered right to your station.</p>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-white/10 bg-black/40 py-8 pb-24 md:pb-8 px-4">
        <div className="container mx-auto max-w-5xl flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-muted-foreground">
          <div className="flex items-center gap-2">
            <span className="font-display font-bold text-foreground tracking-wider">PLAY N'<span className="text-primary">SLAY</span></span>
            <span>• Next-Gen Gaming Experience</span>
          </div>
          <div className="flex items-center gap-6">
            <a href="/contact" className="hover:text-primary transition-colors">Contact Us</a>
            <a href="/games" className="hover:text-primary transition-colors">Games Catalog</a>
          </div>
          <div>
            © {new Date().getFullYear()} Play N' Slay. All rights reserved.
          </div>
        </div>
      </footer>
    </div>
  );
}

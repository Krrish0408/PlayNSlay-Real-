import { useState, useMemo } from "react";
import { Navbar } from "@/components/layout-navbar";
import { useGames } from "@/hooks/use-games";
import { useGameTypes } from "@/hooks/use-game-types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { motion, AnimatePresence } from "framer-motion";
import { useLocation } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import {
  Gamepad2,
  Users,
  Search,
  Sparkles,
  Monitor,
  Flame,
  Filter,
  Tv,
  Car,
  Headphones,
  SlidersHorizontal,
  ArrowRight,
  Loader2
} from "lucide-react";
import type { Game } from "@shared/schema";

import { resolveGameCover } from "@/lib/game-images";

export default function GamesPage() {
  const { games, isLoading: loadingGames } = useGames();
  const { gameTypes } = useGameTypes();
  const { user } = useAuth();
  const { toast } = useToast();
  const [, setLocation] = useLocation();

  const [searchQuery, setSearchQuery] = useState("");
  const [selectedPlatform, setSelectedPlatform] = useState<string>("all");
  const [selectedGenre, setSelectedGenre] = useState<string>("all");
  const [selectedPlayers, setSelectedPlayers] = useState<string>("all");

  // Extract unique genres
  const allGenres = useMemo(() => {
    if (!games) return [];
    const genres = new Set<string>();
    games.forEach((g) => {
      if (g.genre) {
        g.genre.split(",").forEach((item) => genres.add(item.trim()));
      }
    });
    return Array.from(genres).sort();
  }, [games]);

  // Filtered games
  const filteredGames = useMemo(() => {
    if (!games) return [];
    return games.filter((game) => {
      // Search filter
      const matchesSearch =
        searchQuery === "" ||
        game.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (game.genre && game.genre.toLowerCase().includes(searchQuery.toLowerCase())) ||
        game.platforms.toLowerCase().includes(searchQuery.toLowerCase());

      // Platform filter
      const matchesPlatform =
        selectedPlatform === "all" ||
        game.platforms.toLowerCase().includes(selectedPlatform.toLowerCase());

      // Genre filter
      const matchesGenre =
        selectedGenre === "all" ||
        (game.genre && game.genre.toLowerCase().includes(selectedGenre.toLowerCase()));

      // Players filter
      let matchesPlayers = true;
      if (selectedPlayers === "1") {
        matchesPlayers = game.minPlayers === 1;
      } else if (selectedPlayers === "2") {
        matchesPlayers = game.maxPlayers >= 2;
      } else if (selectedPlayers === "4") {
        matchesPlayers = game.maxPlayers >= 3;
      }

      return matchesSearch && matchesPlatform && matchesGenre && matchesPlayers;
    });
  }, [games, searchQuery, selectedPlatform, selectedGenre, selectedPlayers]);

  const getGameCoverImage = (game: Game) => {
    return resolveGameCover(game.title, game.imageUrl, game.genre, game.platforms);
  };

  const handleBookGame = (game: Game) => {
    // Navigate to home page with game query params to pre-select and jump to Step 2
    const params = new URLSearchParams();
    params.set("gameTitle", game.title);
    if (game.platforms) {
      params.set("platform", game.platforms);
    }
    const targetUrl = `/?${params.toString()}#booking-section`;

    if (!user) {
      toast({
        title: "Login Required",
        description: `Please log in or register to book a station for ${game.title}.`,
      });
      setLocation(`/auth?redirect=${encodeURIComponent(targetUrl)}`);
      return;
    }

    setLocation(targetUrl);
  };

  const getPlatformBadges = (platformsStr: string) => {
    const list = platformsStr.split(",").map((p) => p.trim());
    return list.map((platform) => {
      const lower = platform.toLowerCase();
      if (lower.includes("ps5")) {
        return (
          <span
            key={platform}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-semibold bg-cyan-500/10 text-cyan-400 border border-cyan-500/30 shadow-[0_0_10px_rgba(6,182,212,0.2)]"
          >
            <Tv className="w-3 h-3" /> PS5 Station
          </span>
        );
      }
      if (lower.includes("ps4")) {
        return (
          <span
            key={platform}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-semibold bg-indigo-500/10 text-indigo-400 border border-indigo-500/30"
          >
            <Monitor className="w-3 h-3" /> PS4 Station
          </span>
        );
      }
      if (lower.includes("racing")) {
        return (
          <span
            key={platform}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 shadow-[0_0_10px_rgba(16,185,129,0.2)]"
          >
            <Car className="w-3 h-3" /> Racing Simulator
          </span>
        );
      }
      if (lower.includes("vr")) {
        return (
          <span
            key={platform}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-semibold bg-fuchsia-500/10 text-fuchsia-400 border border-fuchsia-500/30 shadow-[0_0_10px_rgba(217,70,239,0.2)]"
          >
            <Headphones className="w-3 h-3" /> VR Gaming Arena
          </span>
        );
      }
      return (
        <span
          key={platform}
          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-semibold bg-primary/10 text-primary border border-primary/30"
        >
          <Gamepad2 className="w-3 h-3" /> {platform}
        </span>
      );
    });
  };

  return (
    <div className="min-h-screen bg-background text-foreground overflow-x-hidden">
      <Navbar />

      {/* Hero Section */}
      <section className="relative pt-24 sm:pt-28 pb-8 sm:pb-12 px-3 sm:px-4 border-b border-white/5 bg-gradient-to-b from-primary/5 via-background to-background">
        <div className="absolute top-10 left-1/2 -translate-x-1/2 w-[340px] sm:w-[700px] h-[250px] sm:h-[300px] bg-primary/10 blur-[80px] sm:blur-[100px] rounded-full pointer-events-none" />
        <div className="absolute top-20 right-10 w-[200px] sm:w-[300px] h-[200px] sm:h-[300px] bg-secondary/10 blur-[60px] sm:blur-[80px] rounded-full pointer-events-none" />

        <div className="container mx-auto text-center relative z-10 max-w-4xl">
          <motion.div
            initial={{ opacity: 0, y: 15 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
          >
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-primary/30 bg-primary/10 text-primary text-xs font-semibold uppercase tracking-wider mb-4 shadow-[0_0_15px_rgba(0,243,255,0.2)]">
              <Sparkles className="w-3.5 h-3.5" /> Complete Lounge Game Library
            </div>
            <h1 className="text-3xl sm:text-4xl md:text-6xl font-display font-black mb-3 sm:mb-4 tracking-tight leading-tight">
              EXPLORE OUR <br />
              <span className="bg-clip-text text-transparent bg-gradient-to-r from-primary via-white to-secondary">
                GAMES & STATIONS
              </span>
            </h1>
            <p className="text-muted-foreground text-sm sm:text-base md:text-lg max-w-2xl mx-auto mb-6 sm:mb-8 px-2">
              Pick your favorite game, check multiplayer capacities and compatible rigs, and jump straight into reservation.
            </p>

            {/* Quick search input */}
            <div className="relative max-w-xl mx-auto px-1 sm:px-0">
              <Search className="absolute left-4 sm:left-5 top-1/2 -translate-y-1/2 w-4 h-4 sm:w-5 sm:h-5 text-muted-foreground" />
              <Input
                type="text"
                placeholder="Search games, genres, consoles..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-10 sm:pl-12 pr-16 h-11 sm:h-13 text-sm sm:text-base bg-card/60 backdrop-blur-md border-white/10 focus:border-primary/60 rounded-xl shadow-lg"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery("")}
                  className="absolute right-3 sm:right-4 top-1/2 -translate-y-1/2 text-xs text-muted-foreground hover:text-foreground font-medium px-2 py-1 rounded bg-white/5 cursor-pointer"
                >
                  Clear
                </button>
              )}
            </div>
          </motion.div>
        </div>
      </section>

      {/* Filters & Content Section */}
      <section className="py-6 sm:py-8 px-3 sm:px-4 container mx-auto">
        {/* Filters Bar */}
        <div className="bg-card/40 backdrop-blur-md border border-white/10 rounded-2xl p-3.5 sm:p-5 mb-6 sm:mb-8 space-y-3 sm:space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 sm:gap-4">
            {/* Station / Platform Filter */}
            <div className="flex items-center gap-1.5 sm:gap-2 flex-wrap">
              <span className="text-xs font-semibold text-muted-foreground uppercase flex items-center gap-1.5 mr-1">
                <Tv className="w-3.5 h-3.5 text-primary" /> Station:
              </span>
              {[
                { id: "all", label: "All Stations" },
                { id: "PS5", label: "PS5 Stations" },
                { id: "PS4", label: "PS4 Stations" },
                { id: "Racing", label: "Racing Sim" },
                { id: "VR", label: "VR Arena" },
              ].map((plat) => (
                <button
                  key={plat.id}
                  onClick={() => setSelectedPlatform(plat.id)}
                  className={`px-3.5 py-1.5 rounded-lg text-xs font-medium transition-all cursor-pointer ${
                    selectedPlatform === plat.id
                      ? "bg-primary text-primary-foreground font-bold shadow-[0_0_15px_rgba(0,243,255,0.4)]"
                      : "bg-white/5 text-muted-foreground hover:text-foreground hover:bg-white/10"
                  }`}
                >
                  {plat.label}
                </button>
              ))}
            </div>

            {/* Players Filter */}
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-semibold text-muted-foreground uppercase flex items-center gap-1.5 mr-1">
                <Users className="w-3.5 h-3.5 text-secondary" /> Players:
              </span>
              {[
                { id: "all", label: "Any" },
                { id: "1", label: "Singleplayer (1P)" },
                { id: "2", label: "2+ Players" },
                { id: "4", label: "3-4 Players (Squad)" },
              ].map((p) => (
                <button
                  key={p.id}
                  onClick={() => setSelectedPlayers(p.id)}
                  className={`px-3.5 py-1.5 rounded-lg text-xs font-medium transition-all cursor-pointer ${
                    selectedPlayers === p.id
                      ? "bg-secondary text-secondary-foreground font-bold shadow-[0_0_15px_rgba(168,85,247,0.4)]"
                      : "bg-white/5 text-muted-foreground hover:text-foreground hover:bg-white/10"
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          {/* Genre Chips */}
          {allGenres.length > 0 && (
            <div className="pt-3 border-t border-white/5 flex items-center gap-1.5 flex-wrap">
              <span className="text-xs font-semibold text-muted-foreground uppercase flex items-center gap-1 mr-2">
                <Filter className="w-3 h-3" /> Genre:
              </span>
              <button
                onClick={() => setSelectedGenre("all")}
                className={`px-2.5 py-1 rounded-md text-xs transition-all cursor-pointer ${
                  selectedGenre === "all"
                    ? "bg-white/20 text-white font-semibold"
                    : "text-muted-foreground hover:text-foreground hover:bg-white/5"
                }`}
              >
                All
              </button>
              {allGenres.map((genre) => (
                <button
                  key={genre}
                  onClick={() => setSelectedGenre(genre)}
                  className={`px-2.5 py-1 rounded-md text-xs transition-all cursor-pointer ${
                    selectedGenre === genre
                      ? "bg-primary/20 text-primary border border-primary/40 font-semibold"
                      : "text-muted-foreground hover:text-foreground hover:bg-white/5"
                  }`}
                >
                  {genre}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Results Counter */}
        <div className="flex items-center justify-between mb-6 px-1">
          <p className="text-sm text-muted-foreground">
            Showing <span className="font-bold text-foreground">{filteredGames.length}</span> of{" "}
            <span className="font-bold text-foreground">{games?.length || 0}</span> games
          </p>
          {(searchQuery || selectedPlatform !== "all" || selectedGenre !== "all" || selectedPlayers !== "all") && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setSearchQuery("");
                setSelectedPlatform("all");
                setSelectedGenre("all");
                setSelectedPlayers("all");
              }}
              className="text-xs text-muted-foreground hover:text-foreground cursor-pointer"
            >
              Reset Filters
            </Button>
          )}
        </div>

        {/* Games Grid */}
        {loadingGames ? (
          <div className="flex flex-col justify-center items-center py-24 gap-4">
            <Loader2 className="w-10 h-10 text-primary animate-spin" />
            <p className="text-muted-foreground">Loading games catalog...</p>
          </div>
        ) : filteredGames.length === 0 ? (
          <div className="text-center py-20 bg-card/20 rounded-2xl border border-white/5">
            <Gamepad2 className="w-12 h-12 text-muted-foreground mx-auto mb-3 opacity-40" />
            <h3 className="text-xl font-bold mb-1">No games found</h3>
            <p className="text-muted-foreground max-w-sm mx-auto text-sm mb-4">
              Try adjusting your search query or relaxing the platform/genre filters.
            </p>
            <Button
              variant="outline"
              onClick={() => {
                setSearchQuery("");
                setSelectedPlatform("all");
                setSelectedGenre("all");
                setSelectedPlayers("all");
              }}
            >
              Clear All Filters
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
            <AnimatePresence>
              {filteredGames.map((game, index) => (
                <motion.div
                  key={game.id}
                  initial={{ opacity: 0, y: 15 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  transition={{ duration: 0.3, delay: Math.min(index * 0.02, 0.4) }}
                  className="group relative flex flex-col justify-between rounded-2xl bg-card/40 border border-white/5 hover:border-primary/40 hover:bg-card/70 transition-all duration-300 hover:shadow-[0_0_30px_rgba(0,243,255,0.18)] overflow-hidden"
                >
                  {/* Game Cover Art Banner */}
                  <div className="relative w-full h-48 overflow-hidden bg-black/50 border-b border-white/10">
                    <img
                      src={getGameCoverImage(game)}
                      alt={game.title}
                      className="w-full h-full object-cover object-center group-hover:scale-108 transition-transform duration-500 ease-out"
                      loading="lazy"
                      onError={(e) => {
                        e.currentTarget.src = "https://images.unsplash.com/photo-1542751371-adc38448a05e?auto=format&fit=crop&q=80&w=800";
                      }}
                    />
                    <div className="absolute inset-0 bg-gradient-to-t from-background via-background/20 to-transparent" />

                    {/* Genre Badge */}
                    {game.genre && (
                      <div className="absolute top-3 left-3">
                        <span className="px-2.5 py-1 rounded-md text-[11px] font-bold bg-black/75 backdrop-blur-md text-primary border border-primary/30 uppercase tracking-wider shadow-md">
                          {game.genre}
                        </span>
                      </div>
                    )}

                    {/* Player Count Badge */}
                    <div className="absolute top-3 right-3">
                      <div className="flex items-center gap-1.5 text-[11px] font-bold text-white bg-black/75 backdrop-blur-md px-2.5 py-1 rounded-md border border-white/20 shadow-md">
                        <Users className="w-3 h-3 text-secondary" />
                        <span>
                          {game.minPlayers === game.maxPlayers
                            ? `${game.minPlayers}P`
                            : `${game.minPlayers}-${game.maxPlayers}P`}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="p-5 flex-1 flex flex-col justify-between">
                    <div>
                      {/* Game Title */}
                      <h3 className="text-lg font-bold font-display group-hover:text-primary transition-colors line-clamp-1 mb-3">
                        {game.title}
                      </h3>

                      {/* Compatible Stations */}
                      <div className="mb-5 space-y-1.5">
                        <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                          Compatible Stations:
                        </p>
                        <div className="flex flex-wrap gap-1.5">
                          {getPlatformBadges(game.platforms)}
                        </div>
                      </div>
                    </div>

                    {/* Book Button */}
                    <div className="pt-4 border-t border-white/5 flex items-center justify-between mt-auto">
                      <div className="text-xs text-muted-foreground">
                        {game.maxPlayers > 1 ? (
                          <span className="text-emerald-400 font-medium flex items-center gap-1">
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                            Multiplayer Ready
                          </span>
                        ) : (
                          <span className="text-muted-foreground">Single Player</span>
                        )}
                      </div>
                      <Button
                        size="sm"
                        onClick={() => handleBookGame(game)}
                        className="bg-primary text-primary-foreground hover:bg-primary/90 font-semibold shadow-[0_0_15px_rgba(0,243,255,0.3)] gap-1.5 group-hover:gap-2 transition-all cursor-pointer"
                      >
                        <span>Book Now</span>
                        <ArrowRight className="w-3.5 h-3.5 transition-transform group-hover:translate-x-0.5" />
                      </Button>
                    </div>
                  </div>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        )}
      </section>
    </div>
  );
}

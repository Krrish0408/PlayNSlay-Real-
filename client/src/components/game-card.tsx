import { GameType } from "@shared/schema";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Users, Clock, Trophy } from "lucide-react";
import { motion } from "framer-motion";
import { useGames } from "@/hooks/use-games";

interface GameCardProps {
  game: GameType;
  onSelect: (game: GameType) => void;
  selected?: boolean;
}

export function GameCard({ game, onSelect, selected }: GameCardProps) {
  const { games } = useGames();
  const priceInRupees = (game.hourlyPrice / 100).toFixed(2);

  const matchingGames = (games || []).filter(g => {
    const p = g.platforms.toLowerCase();
    const name = game.name.toLowerCase();
    if (name.includes("ps5")) return p.includes("ps5") || p.includes("ps-5");
    if (name.includes("ps4")) return p.includes("ps4") || p.includes("ps-4");
    if (name.includes("racing")) return p.includes("racing") || p.includes("rc") || p.includes("rs");
    if (name.includes("vr") || name.includes("cricket")) return p.includes("vr") || p.includes("cricket");
    if (name.includes("xbox")) return p.includes("xbox") || p.includes("ps4") || p.includes("ps5");
    if (name.includes("pc")) return p.includes("pc") || p.includes("ps5");
    return true;
  });

  return (
    <motion.div
      whileHover={{ scale: 1.02 }}
      whileTap={{ scale: 0.98 }}
      className="h-full"
    >
      <Card 
        className={`h-full flex flex-col overflow-hidden border transition-all duration-300 cursor-pointer group ${
          selected 
            ? "border-primary bg-primary/5 shadow-[0_0_30px_rgba(0,243,255,0.15)]" 
            : "border-white/10 bg-card/50 hover:border-primary/50 hover:bg-card/80"
        }`}
        onClick={() => onSelect(game)}
      >
        <div className="relative h-44 sm:h-48 w-full overflow-hidden">
          <div className="absolute inset-0 bg-gradient-to-t from-background to-transparent z-10" />
          <img 
            src={game.imageUrl || "https://images.unsplash.com/photo-1542751371-adc38448a05e?w=800&q=80"} 
            alt={game.name}
            className="h-full w-full object-cover transition-transform duration-700 group-hover:scale-110 opacity-85 group-hover:opacity-100" 
            loading="lazy"
          />
          {/* Availability badge */}
          <div className="absolute top-3 left-3 z-20 bg-emerald-950/80 backdrop-blur-md border border-emerald-500/40 text-emerald-400 px-2.5 py-1 rounded-full text-xs font-semibold flex items-center gap-1.5 shadow-[0_0_10px_rgba(16,185,129,0.3)]">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            <span>Available</span>
          </div>

          {/* Neon price tag */}
          <div className="absolute top-3 right-3 z-20 bg-black/85 backdrop-blur-md border border-primary/50 text-primary px-3 py-1 rounded-full text-xs sm:text-sm font-bold shadow-[0_0_10px_rgba(0,243,255,0.3)]">
            ₹{priceInRupees}/hr
          </div>
        </div>

        <CardHeader className="p-4 sm:p-6 pb-2">
          <CardTitle className="flex justify-between items-start">
            <span className="font-display text-lg sm:text-xl tracking-wide group-hover:text-primary transition-colors">
              {game.name}
            </span>
          </CardTitle>
          <CardDescription className="line-clamp-2 text-xs sm:text-sm text-muted-foreground/80 mt-1">
            {game.description || "Experience top-tier gaming with our premium setup."}
          </CardDescription>
        </CardHeader>

        <CardContent className="p-4 sm:p-6 pt-0 mt-auto space-y-2.5">
          <div className="flex items-center text-xs sm:text-sm text-muted-foreground">
            <Users className="w-4 h-4 mr-2 text-secondary shrink-0" />
            <span>Capacity: {game.maxPlayers} Player{game.maxPlayers > 1 ? 's' : ''}</span>
          </div>
          <div className="flex items-center text-xs sm:text-sm text-muted-foreground">
            <Trophy className="w-4 h-4 mr-2 text-accent shrink-0" />
            <span>Tournament Grade Hardware</span>
          </div>
          
          {/* Games Available list */}
          {matchingGames.length > 0 && (
            <div className="pt-2 border-t border-white/5">
              <div className="text-[10px] sm:text-[11px] font-bold tracking-wider text-muted-foreground uppercase mb-1.5 flex justify-between items-center">
                <span>Featured Titles ({matchingGames.length})</span>
              </div>
              <div className="flex flex-wrap gap-1 max-h-16 overflow-y-auto pr-1">
                {matchingGames.slice(0, 6).map((g) => (
                  <span 
                    key={g.id} 
                    className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] bg-white/5 border border-white/10 text-muted-foreground"
                    title={`${g.title} (${g.maxPlayers === 1 ? '1P' : `1P-${g.maxPlayers}P`})`}
                  >
                    {g.title} ({g.maxPlayers === 1 ? '1P' : `${g.maxPlayers}P`})
                  </span>
                ))}
                {matchingGames.length > 6 && (
                  <span className="text-[10px] text-primary font-semibold self-center">
                    +{matchingGames.length - 6} more
                  </span>
                )}
              </div>
            </div>
          )}
        </CardContent>

        <CardFooter className="p-4 sm:p-6 pt-0">
          <Button 
            className={`w-full h-11 text-xs sm:text-sm font-bold tracking-wider touch-target transition-all ${
              selected 
                ? "bg-primary text-primary-foreground shadow-[0_0_15px_rgba(0,243,255,0.4)]" 
                : "bg-secondary/10 text-secondary hover:bg-secondary hover:text-white"
            }`}
          >
            {selected ? "SELECTED" : "BOOK THIS STATION"}
          </Button>
        </CardFooter>
      </Card>
    </motion.div>
  );
}

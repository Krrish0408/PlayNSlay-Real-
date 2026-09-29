"use client";

import { GameType } from "@/shared/schema";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Users, Trophy } from "lucide-react";
import { motion } from "framer-motion";

interface GameCardProps {
  game: GameType;
  onSelect: (game: GameType) => void;
  selected?: boolean;
}

export function GameCard({ game, onSelect, selected }: GameCardProps) {
  const priceDisplay = `₹${game.hourlyPrice}`;

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
        <div className="relative h-48 w-full overflow-hidden">
          <div className="absolute inset-0 bg-gradient-to-t from-background to-transparent z-10" />
          <img 
            src={game.imageUrl || "/assets/PLAY_N_SLAY_LOGO__1768593233107.jpeg"} 
            alt={game.name}
            className="h-full w-full object-cover transition-transform duration-700 group-hover:scale-110 opacity-80 group-hover:opacity-100" 
          />
          {/* Neon price tag */}
          <div className="absolute top-4 right-4 z-20 bg-black/80 backdrop-blur-md border border-primary/50 text-primary px-3 py-1 rounded-full text-sm font-bold shadow-[0_0_10px_rgba(0,243,255,0.3)]">
            {priceDisplay}/hr
          </div>
        </div>

        <CardHeader>
          <CardTitle className="flex justify-between items-start">
            <span className="font-display text-xl tracking-wide group-hover:text-primary transition-colors">
              {game.name}
            </span>
          </CardTitle>
          <CardDescription className="line-clamp-2 text-muted-foreground/80">
            {game.description || "Experience top-tier gaming with our premium setup."}
          </CardDescription>
        </CardHeader>

        <CardContent className="mt-auto space-y-3">
          <div className="flex items-center text-sm text-muted-foreground">
            <Users className="w-4 h-4 mr-2 text-secondary" />
            Max Players: {game.maxPlayers}
          </div>
          <div className="flex items-center text-sm text-muted-foreground">
            <Trophy className="w-4 h-4 mr-2 text-accent" />
            Tournament Ready
          </div>
        </CardContent>

        <CardFooter>
          <Button 
            className={`w-full font-bold tracking-wider ${
              selected 
                ? "bg-primary text-primary-foreground shadow-[0_0_15px_rgba(0,243,255,0.4)]" 
                : "bg-secondary/10 text-secondary hover:bg-secondary hover:text-white"
            }`}
          >
            {selected ? "SELECTED" : "SELECT STATION"}
          </Button>
        </CardFooter>
      </Card>
    </motion.div>
  );
}

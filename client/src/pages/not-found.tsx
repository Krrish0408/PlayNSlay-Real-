import { Card, CardContent } from "@/components/ui/card";
import { AlertCircle } from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md bg-card/50 border-white/10 text-center">
        <CardContent className="pt-6">
          <div className="flex mb-4 gap-2 justify-center text-destructive">
            <AlertCircle className="h-8 w-8" />
          </div>
          <h1 className="text-4xl font-display font-bold mb-4">404</h1>
          <p className="mt-2 text-muted-foreground mb-6">
            System Glitch. The requested coordinates do not exist in the grid.
          </p>
          <Link href="/">
            <Button className="bg-primary text-primary-foreground hover:bg-primary/90">
              Return to Base
            </Button>
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}

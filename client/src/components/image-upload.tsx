import React, { useState, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Upload, X, Loader2, Image as ImageIcon } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface ImageUploadProps {
  label?: string;
  value: string;
  onChange: (url: string) => void;
  className?: string;
}

export function ImageUpload({ label = "Station Photo", value, onChange, className }: ImageUploadProps) {
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Check size (10MB)
    if (file.size > 10 * 1024 * 1024) {
      toast({
        title: "File too large",
        description: "Please select an image smaller than 10MB.",
        variant: "destructive",
      });
      return;
    }

    const formData = new FormData();
    formData.append("file", file);

    try {
      setIsUploading(true);
      const res = await fetch("/api/upload", {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Upload failed");
      }

      const data = await res.json();
      onChange(data.url);
      toast({
        title: "Image Uploaded ☁️",
        description: "Photo uploaded to Cloudinary successfully!",
      });
    } catch (err: any) {
      toast({
        title: "Upload Failed",
        description: err.message || "Could not upload image to Cloudinary.",
        variant: "destructive",
      });
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  };

  return (
    <div className={`space-y-2 ${className || ""}`}>
      {label && <Label>{label}</Label>}

      {/* Image Preview & Upload Controls */}
      <div className="flex flex-col sm:flex-row items-start gap-4">
        {value ? (
          <div className="relative w-28 h-28 rounded-lg overflow-hidden border border-white/10 bg-background/50 flex-shrink-0 group">
            <img src={value} alt="Preview" className="w-full h-full object-cover" />
            <button
              type="button"
              onClick={() => onChange("")}
              className="absolute top-1 right-1 p-1 rounded-full bg-destructive text-destructive-foreground opacity-90 hover:opacity-100 transition-opacity"
              title="Remove image"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        ) : (
          <div className="w-28 h-28 rounded-lg border border-dashed border-white/20 bg-background/20 flex flex-col items-center justify-center text-muted-foreground flex-shrink-0">
            <ImageIcon className="w-8 h-8 mb-1 opacity-50" />
            <span className="text-[10px]">No Image</span>
          </div>
        )}

        <div className="flex-1 w-full space-y-2">
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileChange}
            accept="image/*"
            className="hidden"
          />

          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isUploading}
              onClick={() => fileInputRef.current?.click()}
              className="border-white/10 hover:border-primary/50 hover:bg-primary/10 gap-2 text-xs"
            >
              {isUploading ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />
                  Uploading to Cloud...
                </>
              ) : (
                <>
                  <Upload className="w-3.5 h-3.5 text-primary" />
                  Upload Photo
                </>
              )}
            </Button>
          </div>

          <div>
            <span className="text-[11px] text-muted-foreground block mb-1">Or paste direct image URL:</span>
            <Input
              value={value}
              onChange={(e) => onChange(e.target.value)}
              placeholder="https://images.unsplash.com/..."
              className="bg-background/50 border-white/10 text-xs h-8"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

"use client";

import { Navbar } from "@/components/layout-navbar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Mail, Phone, MapPin, Send } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const contactSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters"),
  email: z.string().email("Invalid email address"),
  subject: z.string().min(5, "Subject must be at least 5 characters"),
  message: z.string().min(10, "Message must be at least 10 characters"),
});

type ContactFormValues = z.infer<typeof contactSchema>;

export default function ContactPage() {
  const { toast } = useToast();
  const form = useForm<ContactFormValues>({
    resolver: zodResolver(contactSchema),
    defaultValues: {
      name: "",
      email: "",
      subject: "",
      message: "",
    },
  });

  const onSubmit = (data: ContactFormValues) => {
    console.log("Contact form submitted:", data);
    toast({
      title: "Transmission Received",
      description: "We've received your mission briefing and will get back to you shortly.",
    });
    form.reset();
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Navbar />

      <main className="container mx-auto px-4 pt-24 pb-12">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-12">
            <h1 className="text-4xl font-display font-bold mb-4 tracking-tighter">CONTACT HEADQUARTERS</h1>
            <p className="text-muted-foreground max-w-2xl mx-auto">
              Need technical support or want to book a private gaming tournament? Send us a message.
            </p>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            <div className="lg:col-span-1 space-y-6">
              <Card className="bg-card/50 border-white/10">
                <CardContent className="pt-6 space-y-8">
                  <div className="flex items-start gap-4">
                    <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                      <MapPin className="w-5 h-5 text-primary" />
                    </div>
                    <div>
                      <h3 className="font-bold mb-1 uppercase tracking-wide text-sm">Location</h3>
                      <p className="text-muted-foreground text-sm">
                        Play N&apos; Slay, 2nd Floor, Shivarth Plaza, In front of Ranjhi Thana, Ranjhi, Jabalpur
                      </p>
                    </div>
                  </div>

                  <div className="flex items-start gap-4">
                    <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                      <Phone className="w-5 h-5 text-primary" />
                    </div>
                    <div>
                      <h3 className="font-bold mb-1 uppercase tracking-wide text-sm">Communication</h3>
                      <p className="text-muted-foreground text-sm">+91 8817978822</p>
                    </div>
                  </div>

                  <div className="flex items-start gap-4">
                    <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                      <Mail className="w-5 h-5 text-primary" />
                    </div>
                    <div>
                      <h3 className="font-bold mb-1 uppercase tracking-wide text-sm">Electronic Mail</h3>
                      <p className="text-muted-foreground text-sm">immortalconsole7@gmail.com</p>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card className="bg-primary/5 border-primary/20 overflow-hidden relative">
                <div className="absolute inset-0 bg-gradient-to-br from-primary/10 to-transparent pointer-events-none" />
                <CardContent className="pt-6 relative z-10">
                  <h3 className="font-display font-bold text-lg mb-2 italic">OPERATIONAL HOURS</h3>
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Mon - Fri</span>
                      <span className="font-bold text-primary">10:00 - 22:00</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Saturday</span>
                      <span className="font-bold text-primary">09:00 - 00:00</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Sunday</span>
                      <span className="font-bold text-primary">09:00 - 23:00</span>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>

            <Card className="lg:col-span-2 bg-card/50 border-white/10">
              <CardHeader>
                <CardTitle className="font-display tracking-wider">SECURE TRANSMISSION</CardTitle>
              </CardHeader>
              <CardContent>
                <Form {...form}>
                  <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <FormField
                        control={form.control}
                        name="name"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-xs uppercase tracking-widest text-muted-foreground font-bold">
                              Your Name
                            </FormLabel>
                            <FormControl>
                              <Input
                                placeholder="Gamer ID"
                                {...field}
                                className="bg-background/50 border-white/10 focus-visible:ring-primary/50"
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={form.control}
                        name="email"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-xs uppercase tracking-widest text-muted-foreground font-bold">
                              Email Address
                            </FormLabel>
                            <FormControl>
                              <Input
                                placeholder="gamer@nexus.gg"
                                {...field}
                                className="bg-background/50 border-white/10 focus-visible:ring-primary/50"
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </div>
                    <FormField
                      control={form.control}
                      name="subject"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-xs uppercase tracking-widest text-muted-foreground font-bold">
                            Subject
                          </FormLabel>
                          <FormControl>
                            <Input
                              placeholder="Tournament / Station Query"
                              {...field}
                              className="bg-background/50 border-white/10 focus-visible:ring-primary/50"
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="message"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-xs uppercase tracking-widest text-muted-foreground font-bold">
                            Message Briefing
                          </FormLabel>
                          <FormControl>
                            <Textarea
                              placeholder="Detail your request or event query here..."
                              className="min-h-[150px] bg-background/50 border-white/10 focus-visible:ring-primary/50 resize-none"
                              {...field}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <Button
                      type="submit"
                      className="w-full font-display tracking-widest uppercase font-bold text-lg h-12 bg-primary text-primary-foreground hover:bg-primary/90"
                    >
                      <Send className="w-4 h-4 mr-2" />
                      Initiate Transmission
                    </Button>
                  </form>
                </Form>
              </CardContent>
            </Card>
          </div>
        </div>
      </main>
    </div>
  );
}

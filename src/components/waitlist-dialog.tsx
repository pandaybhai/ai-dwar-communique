import { useState, type ReactNode } from "react";
import { z } from "zod";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";

const waitlistSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(100, "Name is too long"),
  business: z.string().trim().min(1, "Business name is required").max(120, "Name is too long"),
  email: z.string().trim().email("Enter a valid email").max(255),
  phone: z
    .string()
    .trim()
    .min(7, "Enter a valid phone number")
    .max(20, "Enter a valid phone number")
    .regex(/^[+0-9()\-\s]+$/, "Enter a valid phone number"),
});

type Errors = Partial<Record<keyof z.infer<typeof waitlistSchema>, string>>;

async function submitWaitlist(values: z.infer<typeof waitlistSchema>) {
  const { error } = await supabase.from("waitlist_signups").insert({
    name: values.name,
    business_name: values.business,
    email: values.email,
    phone: values.phone,
  });
  if (error) throw error;
}

export function WaitlistDialog({ trigger }: { trigger: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const parsed = waitlistSchema.safeParse({
      name: String(form.get("name") ?? ""),
      business: String(form.get("business") ?? ""),
      email: String(form.get("email") ?? ""),
      phone: String(form.get("phone") ?? ""),
    });

    if (!parsed.success) {
      const next: Errors = {};
      for (const issue of parsed.error.issues) {
        const field = issue.path[0] as keyof Errors;
        if (!next[field]) next[field] = issue.message;
      }
      setErrors(next);
      return;
    }

    setErrors({});
    setPending(true);
    try {
      await submitWaitlist(parsed.data);
      setOpen(false);
      toast.success("You're on the list", {
        description: "We'll reach out at " + parsed.data.email + " with your early access invite.",
      });
    } catch {
      toast.error("Something went wrong. Please try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Get early access</DialogTitle>
          <DialogDescription>
            Tell us about your business and we'll send an invite as soon as a slot opens.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <Field id="name" label="Full name" placeholder="Priya Sharma" error={errors.name} />
          <Field
            id="business"
            label="Business name"
            placeholder="Meezoy Retail"
            error={errors.business}
          />
          <Field
            id="email"
            label="Work email"
            type="email"
            placeholder="you@company.com"
            error={errors.email}
          />
          <Field
            id="phone"
            label="Phone number"
            type="tel"
            placeholder="+91 98765 43210"
            error={errors.phone}
          />
          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? "Submitting…" : "Request early access"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  id,
  label,
  error,
  ...props
}: React.ComponentProps<typeof Input> & { id: string; label: string; error?: string | undefined }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} name={id} aria-invalid={!!error} {...props} />
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

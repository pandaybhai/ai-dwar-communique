import {
  BarChart3,
  Contact,
  CreditCard,
  Inbox,
  Megaphone,
  Package,
  MessageSquareText,
  Receipt,
  Settings,
  ShoppingBag,
  Sparkles,
  ShieldCheck,
  Users,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import type { FeatureIcon } from "@/lib/feature-registry";

/** Presentation-only mapping so the manifest itself stays free of UI imports. */
export const FEATURE_ICONS: Record<FeatureIcon, LucideIcon> = {
  inbox: Inbox,
  contact: Contact,
  megaphone: Megaphone,
  "message-square-text": MessageSquareText,
  receipt: Receipt,
  workflow: Workflow,
  "bar-chart": BarChart3,
  "shield-check": ShieldCheck,
  settings: Settings,
  users: Users,
  "credit-card": CreditCard,
  "shopping-bag": ShoppingBag,
  sparkles: Sparkles,
  package: Package,
};

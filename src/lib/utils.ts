import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { toast } from "sonner";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function toastError(title: string, error: unknown) {
  console.error(title, error);
  toast.error(title, {
    description: error instanceof Error ? error.message : String(error),
  });
}

export function toastSuccess(title: string, description?: string) {
  toast.success(title, { description });
}

/** Format a sat amount with locale-aware thousands separators */
export function formatAmount(amount: number, unit = 'sat'): string {
  const formatted = amount.toLocaleString('en-US');
  return `${formatted} ${unit}`;
}

/** Truncate a string in the middle: "abcdefgh" → "abcd...efgh" */
export function truncateMiddle(str: string, startChars = 8, endChars = 8): string {
  if (str.length <= startChars + endChars + 3) return str;
  return `${str.slice(0, startChars)}...${str.slice(-endChars)}`;
}

/** Truncate a mint URL for display */
export function truncateMintUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    if (host.length > 24) return truncateMiddle(host, 10, 10);
    return host;
  } catch {
    return truncateMiddle(url, 12, 8);
  }
}

/** Generate a short human-readable timestamp */
export function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;

  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * AuthCard — Shared wrapper for authentication pages.
 *
 * Renders a centered card with optional logo, title, and description.
 * All auth pages (login, register, forgot-password) use this as their outer shell.
 */

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@linchkit/ui-kit/components";
import type { ReactNode } from "react";

export interface AuthCardProps {
  /** Page title (e.g. "Sign in") */
  title: string;
  /** Subtitle / description below the title */
  description?: string;
  /** Optional logo element rendered above the title */
  logo?: ReactNode;
  /** Card body content */
  children: ReactNode;
  /** Footer content rendered below the card body */
  footer?: ReactNode;
}

export function AuthCard({ title, description, logo, children, footer }: AuthCardProps) {
  return (
    <div className="w-full max-w-sm">
      <Card>
        <CardHeader className="space-y-1 text-center">
          {logo && <div className="mb-2 flex justify-center">{logo}</div>}
          <CardTitle className="text-2xl font-bold">{title}</CardTitle>
          {description && <CardDescription>{description}</CardDescription>}
        </CardHeader>
        <CardContent className="space-y-4">{children}</CardContent>
        {footer && (
          <div className="px-6 pb-6 text-center text-sm text-muted-foreground">{footer}</div>
        )}
      </Card>
    </div>
  );
}

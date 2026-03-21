/**
 * StatusBar — Odoo-style chevron status indicator.
 *
 * Uses clip-path for arrow shapes. Background stripe behind all steps
 * provides visual continuity, with the active step highlighted.
 */

import { cn } from "@/lib/utils"

export interface StatusBarStep {
  value: string
  label: string
  color?: "default" | "success" | "warning" | "danger"
}

export interface StatusBarProps {
  steps: StatusBarStep[]
  current: string
  onStepClick?: (value: string) => void
  className?: string
}

export function StatusBar({ steps, current, onStepClick, className }: StatusBarProps) {
  const currentIndex = steps.findIndex((s) => s.value === current)
  const currentColor = steps[currentIndex]?.color ?? "default"

  return (
    <div
      className={cn(
        "inline-flex items-stretch rounded bg-muted",
        className,
      )}
    >
      {steps.map((step, i) => {
        const isActive = step.value === current
        const isCompleted = i < currentIndex
        const isFirst = i === 0
        const isLast = i === steps.length - 1

        let colorCls: string
        if (isActive) {
          switch (currentColor) {
            case "success":
              colorCls = "bg-green-600 text-white dark:bg-green-500"
              break
            case "warning":
              colorCls = "bg-yellow-500 text-white dark:bg-yellow-400 dark:text-yellow-950"
              break
            case "danger":
              colorCls = "bg-red-600 text-white dark:bg-red-500"
              break
            default:
              colorCls = "bg-primary text-primary-foreground"
          }
        } else if (isCompleted) {
          colorCls = "bg-muted-foreground/15 text-foreground"
        } else {
          // Future steps: slightly visible against the muted background
          colorCls = "bg-muted text-muted-foreground"
        }

        const chevronSize = 8
        let clipPath: string
        if (isFirst && isLast) {
          clipPath = "none"
        } else if (isFirst) {
          clipPath = `polygon(0 0, calc(100% - ${chevronSize}px) 0, 100% 50%, calc(100% - ${chevronSize}px) 100%, 0 100%)`
        } else if (isLast) {
          clipPath = `polygon(0 0, 100% 0, 100% 100%, 0 100%, ${chevronSize}px 50%)`
        } else {
          clipPath = `polygon(0 0, calc(100% - ${chevronSize}px) 0, 100% 50%, calc(100% - ${chevronSize}px) 100%, 0 100%, ${chevronSize}px 50%)`
        }

        return (
          <button
            key={step.value}
            type="button"
            disabled={!onStepClick}
            className={cn(
              "relative px-4 py-1 text-xs font-medium transition-colors",
              !isFirst && "-ml-[4px]",
              colorCls,
              onStepClick && "cursor-pointer hover:opacity-80",
              !onStepClick && "cursor-default",
            )}
            style={{ clipPath }}
            onClick={() => onStepClick?.(step.value)}
          >
            {step.label}
          </button>
        )
      })}
    </div>
  )
}

import * as React from "react"
import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

type Mode = "light" | "dark" | "system"

// The viewer's light/dark choice, saved in this browser. public/theme.js applies it (and follows the system setting).
export function useThemeMode() {
  const read = (): Mode => {
    try {
      const v = localStorage.getItem("theme")
      return v === "light" || v === "dark" ? v : "system"
    } catch {
      return "system"
    }
  }
  const [mode, setMode] = React.useState<Mode>(read)
  const choose = (m: Mode) => {
    try {
      if (m === "system") localStorage.removeItem("theme")
      else localStorage.setItem("theme", m)
    } catch {
      /* private mode: the choice lasts for this page only */
    }
    setMode(m)
    window.dispatchEvent(new Event("themechange"))
  }
  return [mode, choose] as const
}

export function ThemeToggle() {
  const [mode, choose] = useThemeMode()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Theme">
          <SunIcon className="dark:hidden" />
          <MoonIcon className="hidden dark:block" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-40">
        <DropdownMenuLabel>Theme</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup value={mode} onValueChange={(v) => choose(v as Mode)}>
          <DropdownMenuRadioItem value="light">
            <SunIcon /> Light
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">
            <MoonIcon /> Dark
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system">
            <MonitorIcon /> System
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

"use client";

import { ClapperboardIcon, MenuIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { MODULES, NAV_GROUPS, type Module } from "@/lib/navigation";
import { cn } from "@/lib/utils";

export function AppSidebar() {
  return <SidebarFrame pathname={usePathname()} />;
}

// usePathname() suspends while prerendering routes with unknown dynamic params (Cache
// Components), so the layout renders this identical, unhighlighted sidebar as the fallback.
export function AppSidebarFallback() {
  return <SidebarFrame pathname={null} />;
}

function SidebarFrame({ pathname }: { pathname: string | null }) {
  const [open, setOpen] = useState(false);
  // Close the mobile menu when navigating; adjusting state during render avoids an effect.
  const [lastPath, setLastPath] = useState(pathname);
  if (pathname !== lastPath) {
    setLastPath(pathname);
    setOpen(false);
  }

  return (
    <aside className="sticky top-0 z-40 border-b border-sidebar-border bg-sidebar text-sidebar-foreground md:h-screen md:w-64 md:shrink-0 md:border-r md:border-b-0">
      <div className="flex h-full flex-col">
        <div className="flex items-center gap-2.5 px-4 py-3 md:px-5 md:py-5">
          <div className="flex size-9 items-center justify-center rounded-xl bg-linear-to-br from-violet-400 to-fuchsia-500 text-white shadow-lg shadow-violet-500/20">
            <ClapperboardIcon className="size-4.5" />
          </div>
          <div className="leading-tight">
            <span className="block font-semibold tracking-tight">Kids Studio</span>
            <span className="block text-xs text-muted-foreground">Content production</span>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="ml-auto md:hidden"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-controls="app-nav"
            aria-label={open ? "Close menu" : "Open menu"}
          >
            {open ? <XIcon /> : <MenuIcon />}
          </Button>
        </div>

        <nav
          id="app-nav"
          aria-label="Main"
          className={cn(
            "flex-1 flex-col gap-5 overflow-y-auto px-3 pb-4 md:flex",
            open ? "flex max-h-[calc(100dvh-4rem)]" : "hidden",
          )}
        >
          {NAV_GROUPS.map((group) => (
            <div key={group.label} className="grid gap-0.5">
              <p className="px-3 pb-1 text-[11px] font-medium tracking-wider text-muted-foreground/70 uppercase">
                {group.label}
              </p>
              {group.items.map((item) => (
                <NavLink key={item.href} item={item} pathname={pathname} />
              ))}
            </div>
          ))}
          <div className="mt-auto grid gap-0.5 border-t border-sidebar-border pt-3">
            <NavLink item={MODULES.settings} pathname={pathname} />
          </div>
        </nav>
      </div>
    </aside>
  );
}

function NavLink({ item, pathname }: { item: Module; pathname: string | null }) {
  const { href, label, icon: Icon, ready } = item;
  const active = pathname !== null && (href === "/" ? pathname === "/" : pathname.startsWith(href));

  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors",
        active
          ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
          : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
      )}
    >
      <Icon className={cn("size-4", active && "text-primary")} />
      {label}
      {!ready && (
        <span className="ml-auto rounded-full border border-sidebar-border px-1.5 py-px text-[10px] text-muted-foreground/80">
          Soon
        </span>
      )}
    </Link>
  );
}

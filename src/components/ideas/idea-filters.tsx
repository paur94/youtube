"use client";

import { Loader2Icon, SearchIcon, XIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AGE_GROUP_LABELS,
  AGE_GROUPS,
  CATEGORIES,
  CATEGORY_LABELS,
  ideasHref,
  ORIGINALITY_LABELS,
  ORIGINALITY_STATUSES,
  PRIORITIES,
  PRIORITY_LABELS,
  type IdeaFilters,
} from "@/lib/ideas";

// Radix Select doesn't allow an empty-string item value, so "all" stands in for "no filter".
const ALL = "all";

export function IdeaFilterBar({ filters }: { filters: IdeaFilters }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [query, setQuery] = useState(filters.q ?? "");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Keep the search box in sync when the URL changes from elsewhere (a "Clear filters" link,
  // back/forward), but not when the change came from our own debounced search.
  const [sentQuery, setSentQuery] = useState(filters.q);
  if (filters.q !== sentQuery) {
    setSentQuery(filters.q);
    setQuery(filters.q ?? "");
  }

  useEffect(() => () => clearTimeout(timer.current), []);

  function navigate(next: Partial<IdeaFilters>) {
    startTransition(() => {
      router.replace(ideasHref({ ...filters, ...next }), { scroll: false });
    });
  }

  function onSearch(value: string) {
    setQuery(value);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const q = value.trim() || undefined;
      setSentQuery(q);
      navigate({ q });
    }, 300);
  }

  function clearAll() {
    clearTimeout(timer.current);
    setQuery("");
    startTransition(() => router.replace("/ideas", { scroll: false }));
  }

  const active =
    !!filters.q ||
    !!filters.status ||
    !!filters.category ||
    !!filters.ageGroup ||
    !!filters.priority ||
    !!filters.originality;

  return (
    <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
      <div className="relative lg:max-w-xs lg:flex-1">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          value={query}
          onChange={(e) => onSearch(e.target.value)}
          placeholder="Search title, description, tags…"
          aria-label="Search ideas"
          maxLength={100}
          className="pl-8"
        />
        {pending && (
          <Loader2Icon className="absolute top-1/2 right-2.5 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />
        )}
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:flex">
        <FilterSelect
          label="Category"
          allLabel="All categories"
          value={filters.category}
          options={CATEGORIES.map((v) => [v, CATEGORY_LABELS[v]])}
          onChange={(category) => navigate({ category })}
        />
        <FilterSelect
          label="Age"
          allLabel="All ages"
          value={filters.ageGroup}
          options={AGE_GROUPS.map((v) => [v, AGE_GROUP_LABELS[v]])}
          onChange={(ageGroup) => navigate({ ageGroup })}
        />
        <FilterSelect
          label="Priority"
          allLabel="Any priority"
          value={filters.priority}
          options={PRIORITIES.map((v) => [v, PRIORITY_LABELS[v]])}
          onChange={(priority) => navigate({ priority })}
        />
        <FilterSelect
          label="Originality"
          allLabel="Any review status"
          value={filters.originality}
          options={ORIGINALITY_STATUSES.map((v) => [v, ORIGINALITY_LABELS[v]])}
          onChange={(originality) => navigate({ originality })}
        />
      </div>

      {active && (
        <Button variant="ghost" size="sm" onClick={clearAll} className="self-start lg:self-auto">
          <XIcon />
          Clear filters
        </Button>
      )}
    </div>
  );
}

function FilterSelect<T extends string>({
  label,
  allLabel,
  value,
  options,
  onChange,
}: {
  label: string;
  allLabel: string;
  value: T | undefined;
  options: [T, string][];
  onChange: (value: T | undefined) => void;
}) {
  return (
    <Select
      value={value ?? ALL}
      onValueChange={(v) => onChange(v === ALL ? undefined : (v as T))}
    >
      <SelectTrigger aria-label={`Filter by ${label.toLowerCase()}`} className="w-full lg:w-40">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{allLabel}</SelectItem>
        {options.map(([v, text]) => (
          <SelectItem key={v} value={v}>
            {text}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

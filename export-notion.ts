import { Client, isFullBlock, isFullPage } from "@notionhq/client";
import { NotionToMarkdown } from "notion-to-md";
import fs from "node:fs/promises";
import path from "node:path";

const NOTION_TOKEN = requireEnv("NOTION_TOKEN");
const ROOT_PAGE_ID = requireEnv("NOTION_ROOT_PAGE_ID");
const OUTPUT_DIR = process.env.OUTPUT_DIR ?? "notion";

const notion = new Client({ auth: NOTION_TOKEN });

// parseChildPages: false → each page is converted on its own; we handle
// recursion ourselves so we can mirror the page tree as folders/files.
const n2m = new NotionToMarkdown({
  notionClient: notion,
  config: { parseChildPages: false },
});

// Pages already exported (guards against cycles / duplicate references).
const visited = new Set<string>();

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Minimal retry for Notion API rate limits / transient errors.
async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err: unknown) {
      const status = (err as { status?: number }).status;
      const retryable =
        status === 429 || (status !== undefined && status >= 500);
      if (!retryable || i >= attempts - 1) throw err;
      await sleep(1000 * (i + 1));
    }
  }
}

// Make a string safe to use as a file/folder name.
function slugify(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[\/\\?%*:|"<>]/g, "-")
    .replace(/\s+/g, " ")
    .slice(0, 100)
    .trim();
  return cleaned || "untitled";
}

// Avoid two siblings writing to the same file/folder name.
function uniqueName(used: Set<string>, base: string): string {
  let name = base;
  let i = 2;
  while (used.has(name.toLowerCase())) name = `${base} (${i++})`;
  used.add(name.toLowerCase());
  return name;
}

// ---------- rich text / property helpers ----------

type RichText = {
  plain_text: string;
  href?: string | null;
  annotations?: {
    bold: boolean;
    italic: boolean;
    strikethrough: boolean;
    code: boolean;
  };
};

function richTextToMd(rich: RichText[]): string {
  return rich
    .map((t) => {
      let s = t.plain_text;
      const a = t.annotations;
      if (a?.code) s = `\`${s}\``;
      if (a?.bold) s = `**${s}**`;
      if (a?.italic) s = `_${s}_`;
      if (a?.strikethrough) s = `~~${s}~~`;
      if (t.href) s = `[${s}](${t.href})`;
      return s;
    })
    .join("");
}

// Markdown table cells cannot contain raw pipes or newlines.
function escapeCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}

// Convert a database page property to display text.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function propToText(prop: any): string {
  switch (prop?.type) {
    case "title":
      return richTextToMd(prop.title);
    case "rich_text":
      return richTextToMd(prop.rich_text);
    case "number":
      return prop.number?.toString() ?? "";
    case "select":
      return prop.select?.name ?? "";
    case "status":
      return prop.status?.name ?? "";
    case "multi_select":
      return prop.multi_select.map((o: { name: string }) => o.name).join(", ");
    case "date": {
      if (!prop.date) return "";
      return prop.date.end
        ? `${prop.date.start} → ${prop.date.end}`
        : prop.date.start;
    }
    case "checkbox":
      return prop.checkbox ? "✅" : "⬜";
    case "url":
      return prop.url ?? "";
    case "email":
      return prop.email ?? "";
    case "phone_number":
      return prop.phone_number ?? "";
    case "people":
      return prop.people
        .map((p: { name?: string }) => p.name ?? "?")
        .join(", ");
    case "files":
      return prop.files.map((f: { name: string }) => f.name).join(", ");
    case "formula": {
      const f = prop.formula;
      if (f.type === "string") return f.string ?? "";
      if (f.type === "number") return f.number?.toString() ?? "";
      if (f.type === "boolean") return f.boolean ? "true" : "false";
      if (f.type === "date") return f.date?.start ?? "";
      return "";
    }
    case "unique_id":
      return prop.unique_id.prefix
        ? `${prop.unique_id.prefix}-${prop.unique_id.number}`
        : `${prop.unique_id.number ?? ""}`;
    case "created_time":
      return prop.created_time;
    case "last_edited_time":
      return prop.last_edited_time;
    case "relation":
      return prop.relation.length ? `${prop.relation.length} linked` : "";
    default:
      return "";
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function pageTitleFromProps(properties: Record<string, any>): string {
  for (const prop of Object.values(properties)) {
    if (prop.type === "title") {
      const t = prop.title.map((r: RichText) => r.plain_text).join("");
      return t || "untitled";
    }
  }
  return "untitled";
}

// ---------- Notion listing helpers ----------

async function getPageTitle(pageId: string): Promise<string> {
  const page = await withRetry(() =>
    notion.pages.retrieve({ page_id: pageId }),
  );
  return isFullPage(page) ? pageTitleFromProps(page.properties) : "untitled";
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function listAllChildren(blockId: string): Promise<any[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const all: any[] = [];
  let cursor: string | undefined;
  do {
    const res = await withRetry(() =>
      notion.blocks.children.list({
        block_id: blockId,
        start_cursor: cursor,
        page_size: 100,
      }),
    );
    all.push(...res.results);
    cursor = res.has_more ? (res.next_cursor ?? undefined) : undefined;
  } while (cursor);
  return all;
}

type ChildItems = {
  pages: { id: string; title: string }[];
  databases: { id: string; title: string }[];
};

// Find child pages AND child databases, recursing into container blocks
// (toggles, columns, callouts, list items, ...) so nested ones aren't missed.
// We do NOT recurse into child_page / child_database themselves — their
// contents belong to the sub-page / database, exported separately.
async function getChildItems(blockId: string): Promise<ChildItems> {
  const out: ChildItems = { pages: [], databases: [] };
  const blocks = await listAllChildren(blockId);
  for (const block of blocks) {
    if (!isFullBlock(block)) continue;
    if (block.type === "child_page") {
      out.pages.push({ id: block.id, title: block.child_page.title });
    } else if (block.type === "child_database") {
      out.databases.push({ id: block.id, title: block.child_database.title });
    } else if (block.has_children) {
      const nested = await getChildItems(block.id);
      out.pages.push(...nested.pages);
      out.databases.push(...nested.databases);
    }
  }
  return out;
}

// All rows (pages) of a database, in the database's order.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function queryAllRows(databaseId: string): Promise<any[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows: any[] = [];
  let cursor: string | undefined;
  do {
    const res = await withRetry(() =>
      notion.databases.query({
        database_id: databaseId,
        start_cursor: cursor,
        page_size: 100,
      }),
    );
    rows.push(...res.results.filter(isFullPage));
    cursor = res.has_more ? (res.next_cursor ?? undefined) : undefined;
  } while (cursor);
  return rows;
}

// Render database rows as a markdown table of their properties.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowsToMarkdownTable(rows: any[]): string {
  if (rows.length === 0) return "_(empty database)_";
  // Column order: title first, then the rest alphabetically (deterministic).
  const keys = new Set<string>();
  for (const row of rows)
    for (const k of Object.keys(row.properties)) keys.add(k);
  const titleKey = Object.keys(rows[0].properties).find(
    (k) => rows[0].properties[k].type === "title",
  );
  const columns = [
    ...(titleKey ? [titleKey] : []),
    ...[...keys].filter((k) => k !== titleKey).sort(),
  ];
  const header = `| ${columns.map(escapeCell).join(" | ")} |`;
  const divider = `| ${columns.map(() => "---").join(" | ")} |`;
  const body = rows.map(
    (row) =>
      `| ${columns
        .map((c) => escapeCell(propToText(row.properties[c]) ?? ""))
        .join(" | ")} |`,
  );
  return [header, divider, ...body].join("\n");
}

// ---------- custom transformers ----------

// child_database: by default notion-to-md emits ONLY the database title.
// Instead, render the rows inline as a markdown table. Row page bodies are
// exported as separate files by exportDatabase().
n2m.setCustomTransformer("child_database", async (block) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const b = block as any;
  const title = b.child_database?.title || "Untitled database";
  try {
    const rows = await queryAllRows(b.id);
    return `**${title}**\n\n${rowsToMarkdownTable(rows)}`;
  } catch {
    // Linked database views and inaccessible databases can't be queried.
    return `**${title}** _(linked or inaccessible database — content not exported)_`;
  }
});

// table (simple table): upstream collects rows with concurrent push, which
// can scramble row order. Rebuild sequentially to guarantee order.
n2m.setCustomTransformer("table", async (block) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const b = block as any;
  const children = await listAllChildren(b.id);
  const rows: string[][] = [];
  for (const row of children) {
    if (!isFullBlock(row) || row.type !== "table_row") continue;
    rows.push(
      row.table_row.cells.map((cell) =>
        escapeCell(richTextToMd(cell as RichText[])),
      ),
    );
  }
  if (rows.length === 0) return "";
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r: string[]) => [...r, ...Array(width - r.length).fill("")];
  const hasHeader: boolean = b.table?.has_column_header ?? false;
  const header = hasHeader ? pad(rows[0]) : Array(width).fill(" ");
  const body = hasHeader ? rows.slice(1) : rows;
  return [
    `| ${header.join(" | ")} |`,
    `| ${Array(width).fill("---").join(" | ")} |`,
    ...body.map((r) => `| ${pad(r).join(" | ")} |`),
  ].join("\n");
});

// ---------- export ----------

async function pageToMarkdown(pageId: string): Promise<string> {
  const mdBlocks = await n2m.pageToMarkdown(pageId);
  return n2m.toMarkdownString(mdBlocks).parent ?? "";
}

// Recursively export a page and all of its descendants.
//   - page WITH children   -> <dir>/<slug>/index.md + children inside
//   - page WITHOUT children -> <dir>/<slug>.md
async function exportPage(
  pageId: string,
  title: string,
  dir: string,
  usedNames: Set<string>,
): Promise<number> {
  if (visited.has(pageId)) return 0;
  visited.add(pageId);

  const slug = uniqueName(usedNames, slugify(title));
  const body = await pageToMarkdown(pageId);
  const content = `# ${title}\n\n${body}`;
  const children = await getChildItems(pageId);

  let count = 1;
  if (children.pages.length > 0 || children.databases.length > 0) {
    const pageDir = path.join(dir, slug);
    await fs.mkdir(pageDir, { recursive: true });
    await fs.writeFile(path.join(pageDir, "index.md"), content, "utf8");
    const childNames = new Set<string>(["index"]);
    for (const child of children.pages) {
      count += await exportPage(child.id, child.title, pageDir, childNames);
    }
    for (const db of children.databases) {
      count += await exportDatabase(db.id, db.title, pageDir, childNames);
    }
  } else {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${slug}.md`), content, "utf8");
  }
  return count;
}

// Export a database: a folder containing index.md (the property table)
// plus one file/folder per row, each exported as a regular page.
async function exportDatabase(
  databaseId: string,
  title: string,
  dir: string,
  usedNames: Set<string>,
): Promise<number> {
  const slug = uniqueName(usedNames, slugify(title || "Untitled database"));
  const dbDir = path.join(dir, slug);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let rows: any[];
  try {
    rows = await queryAllRows(databaseId);
  } catch {
    console.warn(`  ! Skipping database "${title}" (linked or inaccessible)`);
    return 0;
  }

  await fs.mkdir(dbDir, { recursive: true });
  await fs.writeFile(
    path.join(dbDir, "index.md"),
    `# ${title}\n\n${rowsToMarkdownTable(rows)}\n`,
    "utf8",
  );

  let count = 0;
  const childNames = new Set<string>(["index"]);
  for (const row of rows) {
    const rowTitle = pageTitleFromProps(row.properties);
    count += await exportPage(row.id, rowTitle, dbDir, childNames);
  }
  return count;
}

async function main(): Promise<void> {
  const rootTitle = await getPageTitle(ROOT_PAGE_ID);
  console.log(`Exporting "${rootTitle}" → ${OUTPUT_DIR}/`);

  // Wipe the output dir so pages deleted in Notion also disappear from git.
  await fs.rm(OUTPUT_DIR, { recursive: true, force: true });
  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  const total = await exportPage(
    ROOT_PAGE_ID,
    rootTitle,
    OUTPUT_DIR,
    new Set(),
  );
  console.log(`Done. Exported ${total} page(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

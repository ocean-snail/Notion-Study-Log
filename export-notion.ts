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

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

// Make a string safe to use as a file/folder name.
function slugify(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[\/\\?%*:|"<>]/g, "-") // strip illegal filename chars
    .replace(/\s+/g, " ")
    .slice(0, 100)
    .trim();
  return cleaned || "untitled";
}

// Read the title of a page from its `title` property.
async function getPageTitle(pageId: string): Promise<string> {
  const page = await notion.pages.retrieve({ page_id: pageId });
  if (isFullPage(page)) {
    for (const prop of Object.values(page.properties)) {
      if (prop.type === "title") {
        return prop.title.map((t) => t.plain_text).join("") || "untitled";
      }
    }
  }
  return "untitled";
}

// List immediate child pages of a page/block (handles pagination).
async function getChildPages(
  blockId: string,
): Promise<{ id: string; title: string }[]> {
  const children: { id: string; title: string }[] = [];
  let cursor: string | undefined;
  do {
    const res = await notion.blocks.children.list({
      block_id: blockId,
      start_cursor: cursor,
      page_size: 100,
    });
    for (const block of res.results) {
      if (isFullBlock(block) && block.type === "child_page") {
        children.push({ id: block.id, title: block.child_page.title });
      }
    }
    cursor = res.has_more ? (res.next_cursor ?? undefined) : undefined;
  } while (cursor);
  return children;
}

// Convert a single page's body to Markdown (does not recurse into sub-pages).
async function pageToMarkdown(pageId: string): Promise<string> {
  const mdBlocks = await n2m.pageToMarkdown(pageId);
  return n2m.toMarkdownString(mdBlocks).parent ?? "";
}

// Recursively export a page and all of its descendants.
//   - page WITH children  -> <dir>/<slug>/index.md  + children inside that folder
//   - page WITHOUT children -> <dir>/<slug>.md
async function exportPage(
  pageId: string,
  title: string,
  dir: string,
): Promise<number> {
  const slug = slugify(title);
  const body = await pageToMarkdown(pageId);
  const content = `# ${title}\n\n${body}`;
  const children = await getChildPages(pageId);

  let count = 1;
  if (children.length > 0) {
    const pageDir = path.join(dir, slug);
    await fs.mkdir(pageDir, { recursive: true });
    await fs.writeFile(path.join(pageDir, "index.md"), content, "utf8");
    for (const child of children) {
      count += await exportPage(child.id, child.title, pageDir);
    }
  } else {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${slug}.md`), content, "utf8");
  }
  return count;
}

async function main(): Promise<void> {
  const rootTitle = await getPageTitle(ROOT_PAGE_ID);
  console.log(`Exporting "${rootTitle}" → ${OUTPUT_DIR}/`);

  // Wipe the output dir so pages deleted in Notion also disappear from git.
  await fs.rm(OUTPUT_DIR, { recursive: true, force: true });
  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  const total = await exportPage(ROOT_PAGE_ID, rootTitle, OUTPUT_DIR);
  console.log(`Done. Exported ${total} page(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

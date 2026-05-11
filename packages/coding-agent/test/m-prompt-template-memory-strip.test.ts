import { describe, it, expect } from "bun:test";

const stripMemoryBlocks = (s: string): string =>
    s
        .replace(/<observations>[\s\S]*?<\/observations>/g, "")
        .replace(/<memories>[\s\S]*?<\/memories>/g, "")
        .replace(/<referenced_files>[\s\S]*?<\/referenced_files>/g, "");

describe("m-prompt-template memory:false stripping", () => {
    it("strips <memories> block", () => {
        const input = "before\n<memories>\nsome content\n</memories>\nafter";
        const result = stripMemoryBlocks(input);
        expect(result).not.toContain("<memories>");
        expect(result).not.toContain("some content");
        expect(result).not.toContain("</memories>");
    });

    it("strips <observations> block", () => {
        const input = "before\n<observations>\nsome content\n</observations>\nafter";
        const result = stripMemoryBlocks(input);
        expect(result).not.toContain("<observations>");
        expect(result).not.toContain("some content");
        expect(result).not.toContain("</observations>");
    });

    it("strips <referenced_files> block", () => {
        const input = "before\n<referenced_files>\nsome content\n</referenced_files>\nafter";
        const result = stripMemoryBlocks(input);
        expect(result).not.toContain("<referenced_files>");
        expect(result).not.toContain("some content");
        expect(result).not.toContain("</referenced_files>");
    });

    it("strips all three blocks in one pass", () => {
        const input = [
            "preamble",
            "<observations>\nobs content\n</observations>",
            "<memories>\nmem content\n</memories>",
            "<referenced_files>\nref content\n</referenced_files>",
            "postamble",
        ].join("\n");
        const result = stripMemoryBlocks(input);
        expect(result).not.toContain("<observations>");
        expect(result).not.toContain("obs content");
        expect(result).not.toContain("<memories>");
        expect(result).not.toContain("mem content");
        expect(result).not.toContain("<referenced_files>");
        expect(result).not.toContain("ref content");
        expect(result).toContain("preamble");
        expect(result).toContain("postamble");
    });

    it("preserves new [ENV] bracket tag system prompt", () => {
        const input = "[ENV]\nsome env content\n[/ENV]";
        const result = stripMemoryBlocks(input);
        expect(result).toBe(input);
    });

    it("preserves [CONTRACT] bracket tag", () => {
        const input = "[CONTRACT]\nsome contract content\n[/CONTRACT]";
        const result = stripMemoryBlocks(input);
        expect(result).toBe(input);
    });

    it("preserves text outside memory blocks", () => {
        const before = "this is before";
        const after = "this is after";
        const input = `${before}\n<memories>\nremove me\n</memories>\n${after}`;
        const result = stripMemoryBlocks(input);
        expect(result).toContain(before);
        expect(result).toContain(after);
    });

    it("handles multiline memory blocks", () => {
        const input = [
            "header",
            "<memories>",
            "line one",
            "  line two with indent",
            "    <nested>not a real tag</nested>",
            "line three",
            "</memories>",
            "footer",
        ].join("\n");
        const result = stripMemoryBlocks(input);
        expect(result).not.toContain("<memories>");
        expect(result).not.toContain("line one");
        expect(result).not.toContain("line two with indent");
        expect(result).not.toContain("<nested>");
        expect(result).not.toContain("line three");
        expect(result).toContain("header");
        expect(result).toContain("footer");
    });

    it("no-op when no memory blocks present", () => {
        const input = "plain text\nno special blocks here\n[ROLE]\nsome role content\n[/ROLE]";
        const result = stripMemoryBlocks(input);
        expect(result).toBe(input);
    });

    it("handles empty memory blocks", () => {
        const result = stripMemoryBlocks("<memories></memories>");
        expect(result).toBe("");
    });
});

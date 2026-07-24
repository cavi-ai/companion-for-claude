interface TestNode {
  localName: string;
  children: TestElement[];
  textContent: string;
  getAttribute(name: string): string | null;
}

class TestElement implements TestNode {
  readonly children: TestElement[] = [];
  textContent = "";

  constructor(readonly localName: string, private readonly attributes: Record<string, string> = {}) {}

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }
}

class TestDocument {
  constructor(readonly documentElement: TestElement, private readonly invalid: boolean) {}

  querySelector(selector: string): TestElement | null {
    return selector === "parsererror" && this.invalid ? new TestElement("parsererror") : null;
  }
}

function decodeXml(value: string): string {
  const entities: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  return value.replace(/&(amp|lt|gt|quot|apos);/g, (entity, name: string) => entities[name] ?? entity);
}

export class TestDOMParser {
  parseFromString(xml: string): TestDocument {
    const document = new TestElement("document");
    const stack = [document];
    let invalid = false;
    const tokens = xml.match(/<[^>]*>|[^<]+/g) ?? [];
    for (const token of tokens) {
      if (token.startsWith("<?") || token.startsWith("<!")) continue;
      if (token.startsWith("</")) {
        const name = token.slice(2, -1).trim().split(":").at(-1);
        if (stack.length === 1 || stack.at(-1)?.localName !== name) invalid = true;
        else stack.pop();
        continue;
      }
      if (token.startsWith("<")) {
        const selfClosing = token.endsWith("/>");
        const inside = token.slice(1, selfClosing ? -2 : -1).trim();
        const rawName = inside.match(/^[^\s]+/)?.[0];
        if (rawName === undefined) { invalid = true; continue; }
        const attributes: Record<string, string> = {};
        for (const match of inside.matchAll(/([^\s=]+)\s*=\s*(["'])(.*?)\2/g)) attributes[match[1] ?? ""] = decodeXml(match[3] ?? "");
        const element = new TestElement(rawName.split(":").at(-1) ?? rawName, attributes);
        stack.at(-1)?.children.push(element);
        if (!selfClosing) stack.push(element);
        continue;
      }
      const decoded = decodeXml(token);
      for (const element of stack.slice(1)) element.textContent += decoded;
    }
    if (stack.length !== 1 || document.children.length !== 1) invalid = true;
    return new TestDocument(document.children[0] ?? new TestElement("parsererror"), invalid);
  }
}

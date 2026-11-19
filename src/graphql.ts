// A small GraphQL executor for the shapes gh and github-mcp-server send: a tokenizer and
// recursive-descent parser for the query language (operations, variables, aliases, inline
// fragments, named fragments, input objects, enums), and a type-driven executor over the same
// store the REST surface uses, so a mutation over GraphQL is visible over REST at once.
//
// A GraphQL-level failure (an unknown field) is HTTP 200 with an `errors` array naming the
// field and partial `data`; only a malformed document or body is an HTTP 400. Batching (a JSON
// array of operations) answers an array of envelopes in order.

import { pullFiles, pullMergeable, squashMerge } from './forge.ts';
import { VIEWER, type Issue, type Pull, type Repo, type Store } from './store.ts';
import { decodeCursor, decodeGlobalId, encodeCursor, encodeGlobalId } from './util.ts';

// ---------------------------------------------------------------------------------------------
// tokenizer
// ---------------------------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'ellipsis'; value: '...' };

const NAME_START = /[_A-Za-z]/;
const NAME_CHAR = /[_0-9A-Za-z]/;

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'ellipsis', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      // A block string (""") is not in the suite's documents; reject it plainly.
      if (input.slice(i, i + 3) === '"""') throw new Error('block strings are not supported');
      let j = i + 1;
      let out = '';
      while (j < input.length) {
        const c = input[j];
        if (c === '"') break;
        if (c === '\n' || c === '\r') throw new Error('an unterminated string in the document');
        if (c === '\\') {
          const esc = input[j + 1];
          if (esc === undefined) throw new Error('a trailing backslash in a string');
          if (esc === 'u') {
            const hex = input.slice(j + 2, j + 6);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error('a bad \\u escape in a string');
            out += String.fromCodePoint(Number.parseInt(hex, 16));
            j += 6;
            continue;
          }
          const simple: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          if (!(esc in simple)) throw new Error(`a bad escape \\${esc} in a string`);
          out += simple[esc];
          j += 2;
          continue;
        }
        out += c;
        j += 1;
      }
      if (j >= input.length) throw new Error('an unterminated string in the document');
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      let j = i;
      if (input[j] === '-') j += 1;
      if (input[j] === '0') j += 1;
      else if (input[j] >= '1' && input[j] <= '9') while (j < input.length && input[j] >= '0' && input[j] <= '9') j += 1;
      else throw new Error(`a bad number at ${JSON.stringify(input.slice(i, i + 12))}`);
      let isFloat = false;
      if (input[j] === '.') {
        isFloat = true;
        j += 1;
        if (!(input[j] >= '0' && input[j] <= '9')) throw new Error('a number with no digits after the decimal point');
        while (j < input.length && input[j] >= '0' && input[j] <= '9') j += 1;
      }
      if (input[j] === 'e' || input[j] === 'E') {
        isFloat = true;
        j += 1;
        if (input[j] === '+' || input[j] === '-') j += 1;
        if (!(input[j] >= '0' && input[j] <= '9')) throw new Error('a number with no exponent digits');
        while (j < input.length && input[j] >= '0' && input[j] <= '9') j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (NAME_START.test(ch)) {
      let j = i + 1;
      while (j < input.length && NAME_CHAR.test(input[j])) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`an unexpected character ${JSON.stringify(ch)} in the document`);
  }
  return tokens;
}

// ---------------------------------------------------------------------------------------------
// parser
// ---------------------------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selectionSet: SelectionNode[] | null;
}

interface FragmentNode {
  kind: 'fragment';
  typeCondition: string | null;
  selectionSet: SelectionNode[];
}

interface SpreadNode {
  kind: 'spread';
  name: string;
}

type SelectionNode = FieldNode | FragmentNode | SpreadNode;

interface OperationNode {
  kind: 'query' | 'mutation';
  name: string | null;
  selectionSet: SelectionNode[];
}

interface FragmentDef {
  name: string;
  typeCondition: string;
  selectionSet: SelectionNode[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('the document ends unexpectedly');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected ${JSON.stringify(value)}, saw ${JSON.stringify(token.value)}`);
    }
  }

  private matchPunct(value: string): boolean {
    const token = this.peek();
    if (token?.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expectName(what = 'a name'): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected ${what}, saw ${JSON.stringify(token.value)}`);
    return token.value;
  }

  parseDocument(): { operations: OperationNode[]; fragments: Map<string, FragmentDef> } {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentDef>();
    while (this.pos < this.tokens.length) {
      const token = this.peek()!;
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        operations.push(this.parseOperation());
      } else if (token.kind === 'name' && token.value === 'fragment') {
        const def = this.parseFragmentDef();
        fragments.set(def.name, def);
      } else if (token.kind === 'punct' && token.value === '{') {
        operations.push({ kind: 'query', name: null, selectionSet: this.parseSelectionSet() });
      } else {
        throw new Error(`expected an operation or a fragment, saw ${JSON.stringify(token.value)}`);
      }
    }
    if (operations.length === 0) throw new Error('the document holds no operation');
    return { operations, fragments };
  }

  private parseOperation(): OperationNode {
    const kind = this.expectName('query or mutation') as 'query' | 'mutation';
    let name: string | null = null;
    const next = this.peek();
    if (next?.kind === 'name') name = this.expectName('an operation name');
    if (this.matchPunct('(')) this.parseVariableDefinitions();
    return { kind, name, selectionSet: this.parseSelectionSet() };
  }

  /** Variable definitions: only the names matter to the executor; types are consumed. */
  private parseVariableDefinitions(): void {
    while (!this.matchPunct(')')) {
      this.expectPunct('$');
      this.expectName('a variable name');
      this.expectPunct(':');
      this.parseType();
      if (this.matchPunct('=')) this.parseValue();
    }
  }

  private parseType(): void {
    if (this.matchPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName('a type name');
    }
    this.matchPunct('!');
  }

  private parseFragmentDef(): FragmentDef {
    this.expectName('fragment');
    const name = this.expectName('a fragment name');
    const on = this.expectName('"on"');
    if (on !== 'on') throw new Error(`expected "on" in a fragment definition, saw ${JSON.stringify(on)}`);
    const typeCondition = this.expectName('a type condition');
    return { name, typeCondition, selectionSet: this.parseSelectionSet() };
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.matchPunct('}')) {
      if (this.pos >= this.tokens.length) throw new Error('a selection set is not closed');
      selections.push(this.parseSelection());
    }
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek()!;
    if (token.kind === 'ellipsis') {
      this.next();
      const next = this.peek();
      if (next?.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName('a type condition');
        return { kind: 'fragment', typeCondition, selectionSet: this.parseSelectionSet() };
      }
      if (next?.kind === 'name') {
        return { kind: 'spread', name: this.expectName('a fragment name') };
      }
      return { kind: 'fragment', typeCondition: null, selectionSet: this.parseSelectionSet() };
    }
    const first = this.expectName('a field name');
    let alias: string | null = null;
    let name = first;
    if (this.matchPunct(':')) {
      alias = first;
      name = this.expectName('a field name');
    }
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.matchPunct('(')) {
      while (!this.matchPunct(')')) {
        const argName = this.expectName('an argument name');
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
    }
    // Directives (@include/@skip) are not in the suite's documents; skip any that appear.
    while (this.peek()?.kind === 'punct' && this.peek()?.value === '@') {
      this.next();
      this.expectName('a directive name');
      if (this.matchPunct('(')) {
        let depth = 1;
        while (depth > 0) {
          const t = this.next();
          if (t.kind === 'punct' && t.value === '(') depth += 1;
          if (t.kind === 'punct' && t.value === ')') depth -= 1;
        }
      }
    }
    let selectionSet: SelectionNode[] | null = null;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '{') {
      selectionSet = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, selectionSet };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.expectName('a variable name') };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!this.matchPunct(']')) values.push(this.parseValue());
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!this.matchPunct('}')) {
        const name = this.expectName('an object field name');
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      return { kind: 'object', fields };
    }
    throw new Error(`expected a value, saw ${JSON.stringify(token.value)}`);
  }
}

// ---------------------------------------------------------------------------------------------
// values
// ---------------------------------------------------------------------------------------------

/** A resolved object: its GraphQL type plus the store records its fields read. */
interface GqlObject {
  __typename: string;
  [key: string]: unknown;
}

type GqlValue = null | string | number | boolean | GqlObject | GqlValue[];

interface ExecutorContext {
  store: Store;
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentDef>;
  errors: Array<{ message: string }>;
}

function coerceValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name] ?? null;
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((value) => coerceValue(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = coerceValue(field.value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, ctx: ExecutorContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = coerceValue(arg.value, ctx.variables);
  return out;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  return null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

// ---------------------------------------------------------------------------------------------
// object builders
// ---------------------------------------------------------------------------------------------

function userObject(): GqlObject {
  return { __typename: 'User', login: VIEWER.login, id: encodeGlobalId('User', String(VIEWER.id)), name: VIEWER.name, email: VIEWER.email };
}

function repoObject(store: Store, repo: Repo): GqlObject {
  return { __typename: 'Repository', __repo: repo, __store: store };
}

function issueObject(store: Store, repo: Repo, issue: Issue): GqlObject {
  return { __typename: 'Issue', __repo: repo, __issue: issue, __store: store };
}

function pullObject(store: Store, repo: Repo, pull: Pull): GqlObject {
  return { __typename: 'PullRequest', __repo: repo, __pull: pull, __store: store };
}

function refObject(name: string): GqlObject {
  return { __typename: 'Ref', name };
}

function pageInfoObject(hasNextPage: boolean, startCursor: string | null, endCursor: string | null): GqlObject {
  return { __typename: 'PageInfo', hasNextPage, hasPreviousPage: false, startCursor, endCursor };
}

function issueConnectionObject(nodes: GqlObject[], pageInfo: GqlObject, totalCount: number): GqlObject {
  return { __typename: 'IssueConnection', __nodes: nodes, __pageInfo: pageInfo, totalCount };
}

function pullConnectionObject(nodes: GqlObject[], pageInfo: GqlObject, totalCount: number): GqlObject {
  return { __typename: 'PullRequestConnection', __nodes: nodes, __pageInfo: pageInfo, totalCount };
}

function fileConnectionObject(paths: string[]): GqlObject {
  return { __typename: 'PullRequestChangedFileConnection', __paths: paths };
}

// ---------------------------------------------------------------------------------------------
// introspection (the static schema surface gh feature-detects)
// ---------------------------------------------------------------------------------------------

const TYPE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  // Only fields the executor actually resolves: advertising more would make introspection lie.
  Issue: ['id', 'number', 'title', 'body', 'state', 'repository'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'repository'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description'],
  User: ['id', 'login', 'name', 'email'],
  Ref: ['name'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Query: ['viewer', 'repository', 'node'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
};

const TYPE_ENUM_VALUES: Readonly<Record<string, readonly string[]>> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
};

function typeObject(name: string): GqlObject | null {
  const fields = TYPE_FIELDS[name];
  const enumValues = TYPE_ENUM_VALUES[name];
  if (fields === undefined && enumValues === undefined) return null;
  return { __typename: '__Type', name, __fields: fields ?? [], __enumValues: enumValues ?? [] };
}

// ---------------------------------------------------------------------------------------------
// connections
// ---------------------------------------------------------------------------------------------

interface OrderBy {
  field: string;
  direction: 'ASC' | 'DESC';
}

function orderByOf(args: Record<string, unknown>): OrderBy {
  const orderBy = asRecord(args.orderBy);
  const direction = orderBy?.direction === 'ASC' ? 'ASC' : 'DESC';
  return { field: asString(orderBy?.field) ?? 'CREATED_AT', direction };
}

/**
 * Page a list of records ordered by creation sequence. The cursor is the last record's
 * sequence; DESC pages to smaller sequences, ASC to larger ones.
 */
function pageBySeq<T extends { createdSeq: number }>(
  records: readonly T[],
  order: OrderBy,
  first: number | null,
  after: string | null,
): { page: T[]; hasNextPage: boolean } {
  const sorted = [...records].sort((a, b) => (order.direction === 'ASC' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
  let start = 0;
  if (after !== null && after !== '') {
    const seq = decodeCursor(after);
    if (seq !== null) {
      const index = sorted.findIndex((record) => record.createdSeq === seq);
      if (index >= 0) start = index + 1;
    }
  }
  const limit = first ?? sorted.length;
  const page = sorted.slice(start, start + limit);
  return { page, hasNextPage: start + page.length < sorted.length };
}

function issuesConnection(ctx: ExecutorContext, repo: Repo, args: Record<string, unknown>): GqlObject {
  const states = Array.isArray(args.states) ? (args.states as unknown[]).filter((s): s is string => typeof s === 'string') : null;
  let issues = [...repo.issues.values()];
  if (states !== null) {
    const wanted = new Set(states.map((s) => s.toLowerCase()));
    issues = issues.filter((issue) => wanted.has(issue.state));
  }
  const order = orderByOf(args);
  const first = asInt(args.first);
  const after = asString(args.after);
  const { page, hasNextPage } = pageBySeq(issues, order, first, after);
  const nodes = page.map((issue) => issueObject(ctx.store, repo, issue));
  const startCursor = page.length > 0 ? encodeCursor(page[0].createdSeq) : null;
  const endCursor = page.length > 0 ? encodeCursor(page[page.length - 1].createdSeq) : null;
  return issueConnectionObject(nodes, pageInfoObject(hasNextPage, startCursor, endCursor), issues.length);
}

function pullsConnection(ctx: ExecutorContext, repo: Repo, args: Record<string, unknown>): GqlObject {
  const states = Array.isArray(args.states) ? (args.states as unknown[]).filter((s): s is string => typeof s === 'string') : ['OPEN'];
  const wanted = new Set(states.map((s) => s.toUpperCase()));
  const pulls = [...repo.pulls.values()].filter((pull) => {
    const state = pull.merged ? 'MERGED' : pull.state.toUpperCase();
    return wanted.has(state);
  });
  const order = orderByOf(args);
  const first = asInt(args.first);
  const after = asString(args.after);
  const { page, hasNextPage } = pageBySeq(pulls, order, first, after);
  const nodes = page.map((pull) => pullObject(ctx.store, repo, pull));
  const startCursor = page.length > 0 ? encodeCursor(page[0].createdSeq) : null;
  const endCursor = page.length > 0 ? encodeCursor(page[page.length - 1].createdSeq) : null;
  return pullConnectionObject(nodes, pageInfoObject(hasNextPage, startCursor, endCursor), pulls.length);
}

// ---------------------------------------------------------------------------------------------
// field resolution
// ---------------------------------------------------------------------------------------------

function unknownField(ctx: ExecutorContext, typeName: string, fieldName: string): null {
  ctx.errors.push({ message: `Cannot query field "${fieldName}" on type "${typeName}".` });
  return null;
}

function resolveGlobalId(ctx: ExecutorContext, id: string): { kind: string; key: string } | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null) {
    ctx.errors.push({ message: `The id ${JSON.stringify(id)} is not a valid global id.` });
    return null;
  }
  return decoded;
}

function resolveField(ctx: ExecutorContext, parent: GqlObject, field: FieldNode): unknown {
  const type = parent.__typename;
  const name = field.name;
  const args = argsOf(field, ctx);
  const store = ctx.store;

  // -- Query ------------------------------------------------------------------
  if (type === 'Query') {
    if (name === 'viewer') return userObject();
    if (name === 'repository') {
      const owner = asString(args.owner);
      const repoName = asString(args.name);
      if (owner === null || repoName === null) return null;
      const repo = store.getRepo(owner, repoName);
      return repo ? repoObject(store, repo) : null;
    }
    if (name === 'node') {
      const id = asString(args.id);
      if (id === null) return null;
      const decoded = resolveGlobalId(ctx, id);
      if (decoded === null) return null;
      if (decoded.kind === 'Repository') {
        const repo = store.repoByGlobalId(decoded.kind, decoded.key);
        return repo ? repoObject(store, repo) : null;
      }
      if (decoded.kind === 'Issue') {
        const found = store.issueByGlobalId(decoded.kind, decoded.key);
        return found ? issueObject(store, found.repo, found.issue) : null;
      }
      if (decoded.kind === 'PullRequest') {
        const found = store.pullByGlobalId(decoded.kind, decoded.key);
        return found ? pullObject(store, found.repo, found.pull) : null;
      }
      return null;
    }
    if (name === '__type') {
      const typeName = asString(args.name);
      return typeName === null ? null : typeObject(typeName);
    }
    return unknownField(ctx, type, name);
  }

  // -- Mutation ---------------------------------------------------------------
  if (type === 'Mutation') {
    if (name === 'createIssue') return mutateCreateIssue(ctx, asRecord(args.input));
    if (name === 'closeIssue') return mutateCloseIssue(ctx, asRecord(args.input));
    if (name === 'createPullRequest') return mutateCreatePullRequest(ctx, asRecord(args.input));
    if (name === 'mergePullRequest') return mutateMergePullRequest(ctx, asRecord(args.input));
    if (name === 'addComment') return mutateAddComment(ctx, asRecord(args.input));
    return unknownField(ctx, type, name);
  }

  // -- User -------------------------------------------------------------------
  if (type === 'User') {
    if (name === 'login') return parent.login ?? VIEWER.login;
    if (name === 'id') return parent.id ?? VIEWER.id;
    if (name === 'name') return parent.name ?? VIEWER.name;
    if (name === 'email') return parent.email ?? VIEWER.email;
    return unknownField(ctx, type, name);
  }

  // -- Repository ---------------------------------------------------------------
  if (type === 'Repository') {
    const repo = parent.__repo as Repo;
    if (name === 'id') return store.repoGlobalId(repo);
    if (name === 'databaseId') return repo.id;
    if (name === 'name') return repo.name;
    if (name === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
    if (name === 'description') return repo.description;
    if (name === 'owner') return userObject();
    if (name === 'defaultBranchRef') {
      const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      return tip === undefined ? null : refObject(repo.defaultBranch);
    }
    if (name === 'viewerPermission') return 'ADMIN';
    if (name === 'hasIssuesEnabled') return true;
    if (name === 'issue') {
      const number = asInt(args.number);
      if (number === null) return null;
      const issue = repo.issues.get(number);
      return issue ? issueObject(store, repo, issue) : null;
    }
    if (name === 'issues') return issuesConnection(ctx, repo, args);
    if (name === 'pullRequests') return pullsConnection(ctx, repo, args);
    if (name === 'pullRequest') {
      const number = asInt(args.number);
      if (number === null) return null;
      const pull = repo.pulls.get(number);
      return pull ? pullObject(store, repo, pull) : null;
    }
    return unknownField(ctx, type, name);
  }

  // -- Ref ----------------------------------------------------------------------
  if (type === 'Ref') {
    if (name === 'name') return parent.name ?? null;
    return unknownField(ctx, type, name);
  }

  // -- Issue ----------------------------------------------------------------------
  if (type === 'Issue') {
    const repo = parent.__repo as Repo;
    const issue = parent.__issue as Issue;
    if (name === 'id') return store.issueGlobalId(repo, issue);
    if (name === 'number') return issue.number;
    if (name === 'title') return issue.title;
    if (name === 'body') return issue.body;
    if (name === 'state') return issue.state === 'open' ? 'OPEN' : 'CLOSED';
    if (name === 'repository') return repoObject(store, repo);
    return unknownField(ctx, type, name);
  }

  // -- PullRequest ------------------------------------------------------------------
  if (type === 'PullRequest') {
    const repo = parent.__repo as Repo;
    const pull = parent.__pull as Pull;
    if (name === 'id') return store.pullGlobalId(repo, pull);
    if (name === 'number') return pull.number;
    if (name === 'title') return pull.title;
    if (name === 'body') return pull.body;
    if (name === 'state') return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
    if (name === 'merged') return pull.merged;
    if (name === 'headRefName') return pull.headRef;
    if (name === 'baseRefName') return pull.baseRef;
    if (name === 'mergeable') {
      if (pull.state !== 'open') return 'UNKNOWN';
      return pullMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
    }
    if (name === 'files') {
      const first = asInt(args.first);
      const files = pullFiles(repo, pull);
      const paths = files.map((file) => file.filename);
      const sliced = first === null ? paths : paths.slice(0, first);
      return fileConnectionObject(sliced);
    }
    if (name === 'repository') return repoObject(store, repo);
    return unknownField(ctx, type, name);
  }

  // -- Connections ------------------------------------------------------------------
  if (type === 'IssueConnection' || type === 'PullRequestConnection') {
    if (name === 'nodes') return (parent.__nodes as GqlObject[]) ?? [];
    if (name === 'pageInfo') return parent.__pageInfo ?? null;
    if (name === 'totalCount') return parent.totalCount ?? 0;
    return unknownField(ctx, type, name);
  }
  if (type === 'PullRequestChangedFileConnection') {
    if (name === 'nodes') {
      const paths = (parent.__paths as string[]) ?? [];
      return paths.map((path) => ({ __typename: 'PullRequestChangedFile', path }));
    }
    if (name === 'pageInfo') {
      const paths = (parent.__paths as string[]) ?? [];
      return pageInfoObject(false, null, paths.length > 0 ? encodeCursor(paths.length - 1) : null);
    }
    return unknownField(ctx, type, name);
  }
  if (type === 'PullRequestChangedFile') {
    if (name === 'path') return parent.path ?? null;
    return unknownField(ctx, type, name);
  }
  if (type === 'PageInfo') {
    if (name === 'hasNextPage') return parent.hasNextPage ?? false;
    if (name === 'hasPreviousPage') return parent.hasPreviousPage ?? false;
    if (name === 'startCursor') return parent.startCursor ?? null;
    if (name === 'endCursor') return parent.endCursor ?? null;
    return unknownField(ctx, type, name);
  }

  // -- Mutation payloads --------------------------------------------------------------
  if (type === 'CreateIssuePayload' || type === 'CloseIssuePayload') {
    if (name === 'issue') return (parent.__issueObject as GqlObject | null) ?? null;
    return unknownField(ctx, type, name);
  }
  if (type === 'CreatePullRequestPayload' || type === 'MergePullRequestPayload') {
    if (name === 'pullRequest') return (parent.__pullObject as GqlObject | null) ?? null;
    return unknownField(ctx, type, name);
  }
  if (type === 'AddCommentPayload') {
    if (name === 'commentEdge') return (parent.__commentEdge as GqlObject | null) ?? null;
    return unknownField(ctx, type, name);
  }
  if (type === 'IssueCommentEdge') {
    if (name === 'node') return (parent.__comment as GqlObject | null) ?? null;
    if (name === 'cursor') return parent.cursor ?? null;
    return unknownField(ctx, type, name);
  }
  if (type === 'IssueComment') {
    if (name === 'id') return parent.id ?? null;
    if (name === 'body') return parent.body ?? null;
    return unknownField(ctx, type, name);
  }

  // -- Introspection ------------------------------------------------------------------
  if (type === '__Type') {
    if (name === 'name') return parent.name ?? null;
    if (name === 'fields') {
      const fields = (parent.__fields as readonly string[]) ?? [];
      return fields.map((fieldName) => ({ __typename: '__Field', name: fieldName }));
    }
    if (name === 'enumValues') {
      const values = (parent.__enumValues as readonly string[]) ?? [];
      return values.map((value) => ({ __typename: '__EnumValue', name: value }));
    }
    return unknownField(ctx, type, name);
  }
  if (type === '__Field' || type === '__EnumValue') {
    if (name === 'name') return parent.name ?? null;
    return unknownField(ctx, type, name);
  }

  return unknownField(ctx, type, name);
}

// ---------------------------------------------------------------------------------------------
// mutations
// ---------------------------------------------------------------------------------------------

function mutateCreateIssue(ctx: ExecutorContext, input: Record<string, unknown> | null): GqlObject | null {
  const store = ctx.store;
  if (input === null) {
    ctx.errors.push({ message: 'createIssue needs an input.' });
    return null;
  }
  const repositoryId = asString(input.repositoryId);
  const title = asString(input.title);
  if (repositoryId === null || title === null) {
    ctx.errors.push({ message: 'createIssue needs repositoryId and title.' });
    return null;
  }
  const decoded = resolveGlobalId(ctx, repositoryId);
  if (decoded === null) return null;
  const repo = store.repoByGlobalId(decoded.kind, decoded.key);
  if (!repo) {
    ctx.errors.push({ message: `Repository not found: ${repositoryId}` });
    return null;
  }
  const body = asString(input.body) ?? '';
  const issue = store.createIssue(repo, title, body, []);
  return { __typename: 'CreateIssuePayload', __issueObject: issueObject(store, repo, issue) };
}

function mutateCloseIssue(ctx: ExecutorContext, input: Record<string, unknown> | null): GqlObject | null {
  const store = ctx.store;
  if (input === null) {
    ctx.errors.push({ message: 'closeIssue needs an input.' });
    return null;
  }
  const issueId = asString(input.issueId);
  if (issueId === null) {
    ctx.errors.push({ message: 'closeIssue needs issueId.' });
    return null;
  }
  const decoded = resolveGlobalId(ctx, issueId);
  if (decoded === null) return null;
  const found = store.issueByGlobalId(decoded.kind, decoded.key);
  if (!found) {
    ctx.errors.push({ message: `Issue not found: ${issueId}` });
    return null;
  }
  store.setIssueState(found.repo, found.issue, 'closed');
  return { __typename: 'CloseIssuePayload', __issueObject: issueObject(store, found.repo, found.issue) };
}

function mutateCreatePullRequest(ctx: ExecutorContext, input: Record<string, unknown> | null): GqlObject | null {
  const store = ctx.store;
  if (input === null) {
    ctx.errors.push({ message: 'createPullRequest needs an input.' });
    return null;
  }
  const repositoryId = asString(input.repositoryId);
  const headRefName = asString(input.headRefName);
  const baseRefName = asString(input.baseRefName);
  const title = asString(input.title);
  if (repositoryId === null || headRefName === null || baseRefName === null || title === null) {
    ctx.errors.push({ message: 'createPullRequest needs repositoryId, headRefName, baseRefName and title.' });
    return null;
  }
  const decoded = resolveGlobalId(ctx, repositoryId);
  if (decoded === null) return null;
  const repo = store.repoByGlobalId(decoded.kind, decoded.key);
  if (!repo) {
    ctx.errors.push({ message: `Repository not found: ${repositoryId}` });
    return null;
  }
  const body = asString(input.body) ?? '';
  const pull = store.createPull(repo, title, body, headRefName, baseRefName);
  return { __typename: 'CreatePullRequestPayload', __pullObject: pullObject(store, repo, pull) };
}

function mutateMergePullRequest(ctx: ExecutorContext, input: Record<string, unknown> | null): GqlObject | null {
  const store = ctx.store;
  if (input === null) {
    ctx.errors.push({ message: 'mergePullRequest needs an input.' });
    return null;
  }
  const pullRequestId = asString(input.pullRequestId);
  if (pullRequestId === null) {
    ctx.errors.push({ message: 'mergePullRequest needs pullRequestId.' });
    return null;
  }
  const decoded = resolveGlobalId(ctx, pullRequestId);
  if (decoded === null) return null;
  const found = store.pullByGlobalId(decoded.kind, decoded.key);
  if (!found) {
    ctx.errors.push({ message: `Pull request not found: ${pullRequestId}` });
    return null;
  }
  const outcome = squashMerge(store, found.repo, found.pull);
  if (!outcome.ok) {
    ctx.errors.push({ message: outcome.conflict ? 'Pull Request is not mergeable' : outcome.error });
    return null;
  }
  return { __typename: 'MergePullRequestPayload', __pullObject: pullObject(store, found.repo, found.pull) };
}

function mutateAddComment(ctx: ExecutorContext, input: Record<string, unknown> | null): GqlObject | null {
  const store = ctx.store;
  if (input === null) {
    ctx.errors.push({ message: 'addComment needs an input.' });
    return null;
  }
  const subjectId = asString(input.subjectId);
  const body = asString(input.body);
  if (subjectId === null || body === null) {
    ctx.errors.push({ message: 'addComment needs subjectId and body.' });
    return null;
  }
  const decoded = resolveGlobalId(ctx, subjectId);
  if (decoded === null) return null;
  let repo: Repo | undefined;
  let number: number | undefined;
  if (decoded.kind === 'Issue') {
    const found = store.issueByGlobalId(decoded.kind, decoded.key);
    if (found) {
      repo = found.repo;
      number = found.issue.number;
    }
  } else if (decoded.kind === 'PullRequest') {
    const found = store.pullByGlobalId(decoded.kind, decoded.key);
    if (found) {
      repo = found.repo;
      number = found.pull.number;
    }
  }
  if (!repo || number === undefined) {
    ctx.errors.push({ message: `Comment subject not found: ${subjectId}` });
    return null;
  }
  const comment = store.addComment(repo, number, body);
  const node: GqlObject = { __typename: 'IssueComment', id: store.commentGlobalId(repo, comment), body: comment.body };
  return {
    __typename: 'AddCommentPayload',
    __commentEdge: { __typename: 'IssueCommentEdge', __comment: node, cursor: encodeCursor(comment.createdSeq) },
  };
}

// ---------------------------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------------------------

function executeSelectionSet(
  ctx: ExecutorContext,
  parent: GqlObject,
  selections: readonly SelectionNode[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'field') {
      const key = selection.alias ?? selection.name;
      const value = resolveField(ctx, parent, selection);
      out[key] = completeValue(ctx, value, selection.selectionSet);
    } else if (selection.kind === 'fragment') {
      if (selection.typeCondition !== null && selection.typeCondition !== parent.__typename) continue;
      Object.assign(out, executeSelectionSet(ctx, parent, selection.selectionSet));
    } else if (selection.kind === 'spread') {
      const def = ctx.fragments.get(selection.name);
      if (!def) {
        ctx.errors.push({ message: `Unknown fragment "${selection.name}".` });
        continue;
      }
      if (def.typeCondition !== parent.__typename) continue;
      Object.assign(out, executeSelectionSet(ctx, parent, def.selectionSet));
    }
  }
  return out;
}

function completeValue(ctx: ExecutorContext, value: unknown, selectionSet: SelectionNode[] | null): unknown {
  if (value === null || value === undefined) return null;
  if (selectionSet === null) return value;
  if (Array.isArray(value)) {
    return value.map((entry) => completeValue(ctx, entry, selectionSet));
  }
  if (typeof value === 'object') {
    return executeSelectionSet(ctx, value as GqlObject, selectionSet);
  }
  return value;
}

export interface GraphQLEnvelope {
  data?: unknown;
  errors?: Array<{ message: string }>;
}

function executeOperation(
  store: Store,
  document: { operations: OperationNode[]; fragments: Map<string, FragmentDef> },
  variables: Record<string, unknown>,
  operationName: string | undefined,
): GraphQLEnvelope {
  let operation = document.operations[0];
  if (operationName !== undefined) {
    const named = document.operations.find((candidate) => candidate.name === operationName);
    if (named) operation = named;
    else {
      return { data: null, errors: [{ message: `Unknown operation named "${operationName}".` }] };
    }
  }
  const ctx: ExecutorContext = { store, variables, fragments: document.fragments, errors: [] };
  const root: GqlObject = { __typename: operation.kind === 'mutation' ? 'Mutation' : 'Query' };
  const data = executeSelectionSet(ctx, root, operation.selectionSet);
  if (ctx.errors.length > 0) return { data, errors: ctx.errors };
  return { data };
}

// ---------------------------------------------------------------------------------------------
// HTTP entry point
// ---------------------------------------------------------------------------------------------

export interface GraphQLResult {
  status: number;
  body: unknown;
}

function parseError(message: string): GraphQLResult {
  return { status: 400, body: { errors: [{ message }] } };
}

export function handleGraphQL(store: Store, bodyText: string): GraphQLResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return parseError('Problems parsing JSON');
  }
  const operations = Array.isArray(parsed) ? parsed : [parsed];
  const envelopes: GraphQLEnvelope[] = [];
  for (const operation of operations) {
    const record = asRecord(operation);
    if (record === null) {
      envelopes.push({ data: null, errors: [{ message: 'An operation must be a JSON object.' }] });
      continue;
    }
    const query = asString(record.query);
    if (query === null) {
      envelopes.push({ data: null, errors: [{ message: 'Must provide query string.' }] });
      continue;
    }
    const variables = asRecord(record.variables) ?? {};
    const operationName = asString(record.operationName) ?? undefined;
    let document: { operations: OperationNode[]; fragments: Map<string, FragmentDef> };
    try {
      document = new Parser(tokenize(query)).parseDocument();
    } catch (err) {
      envelopes.push({ data: null, errors: [{ message: err instanceof Error ? err.message : 'Syntax error in the document.' }] });
      continue;
    }
    envelopes.push(executeOperation(store, document, variables, operationName));
  }
  if (Array.isArray(parsed)) return { status: 200, body: envelopes };
  return { status: 200, body: envelopes[0] };
}

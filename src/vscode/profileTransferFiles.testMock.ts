type UriChange = {
  readonly scheme?: string;
  readonly authority?: string;
  readonly path?: string;
  readonly query?: string;
  readonly fragment?: string;
};

export class MockUri {
  static parse(value: string): MockUri {
    const parsed = new URL(value);
    return new MockUri(
      parsed.protocol.slice(0, -1),
      parsed.host,
      parsed.pathname,
      parsed.search.slice(1),
      parsed.hash.slice(1),
    );
  }

  constructor(
    readonly scheme: string,
    readonly authority: string,
    readonly path: string,
    readonly query = '',
    readonly fragment = '',
  ) {}

  with(change: UriChange): MockUri {
    return new MockUri(
      change.scheme ?? this.scheme,
      change.authority ?? this.authority,
      change.path ?? this.path,
      change.query ?? this.query,
      change.fragment ?? this.fragment,
    );
  }

  toString(): string {
    const query = this.query.length > 0 ? `?${this.query}` : '';
    const fragment = this.fragment.length > 0 ? `#${this.fragment}` : '';
    return `${this.scheme}://${this.authority}${this.path}${query}${fragment}`;
  }
}

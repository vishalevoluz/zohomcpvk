interface Props {
  scopes: string[];
}

export default function ScopeHint({ scopes }: Props) {
  return (
    <p className="scope-hint">
      <span className="scope-hint-icon">💡</span>
      <span>
        Make sure {scopes.length > 1 ? "these scopes are" : "this scope is"} attached to the Zoho CRM
        tool on your <a href="https://www.zoho.com/mcp/" target="_blank" rel="noopener noreferrer">Zoho MCP server</a> and
        approved under <strong>Authorized Tools</strong>:{" "}
        {scopes.map((s, i) => (
          <span key={s}>
            <code>{s}</code>
            {i < scopes.length - 1 ? ", " : ""}
          </span>
        ))}
      </span>
    </p>
  );
}

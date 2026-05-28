/**
 * Fixture for the import-meta-url server-side test. Exposes `import.meta.url`
 * as JSON so the test can assert that the URL resolves to the page's source
 * file (not the bundled entry path). Mirrors Next.js's
 * `test/e2e/import-meta/pages/index.tsx` page.
 */
export default function Page() {
  const data = {
    url: import.meta.url,
  };
  return <div id="test-data">{JSON.stringify(data)}</div>;
}

import { connection } from "next/server";
import { Suspense } from "react";
import { Form } from "./form";

// Ported from Next.js: test/e2e/app-dir/use-cache-with-server-function-props
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/use-cache-with-server-function-props/app/nested-cache/page.tsx
//
// Inline "use cache" functions defined inside a cached component are passed
// as props to a client component, which invokes them via useActionState.
// This requires the cached functions to be registered as server references
// (serializable into the RSC payload, resolvable on action POST).

export default function UseCacheNestedFnPropsPage() {
  return (
    <div data-testid="use-cache-nested-fn-props-page">
      <Suspense fallback={<h1>Loading...</h1>}>
        <Dynamic />
      </Suspense>
      <CachedForm />
    </div>
  );
}

async function CachedForm() {
  "use cache";

  return (
    <Form
      getDate={async () => {
        "use cache";
        return new Date().toISOString();
      }}
      getRandom={async function getRandom() {
        "use cache";
        return Math.random();
      }}
    />
  );
}

const Dynamic = async () => {
  await connection();
  return <h1>Dynamic</h1>;
};

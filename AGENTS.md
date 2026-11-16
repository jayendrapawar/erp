# Shayona Inventory Development Rules

## Project

* This is the Shayona Inventory Management application.
* Understand the existing architecture before making changes.
* Use the existing technology stack and coding conventions.
* Do not rewrite working features unnecessarily.

## Git

* Work on the development branch.
* Never push directly to main.
* Never deploy or merge without my explicit approval.
* Keep changes small and reviewable.

## Database

* Local development must use the Neon development branch.
* Never connect local development to production.
* Never run destructive SQL or database migrations without explaining them and getting approval.
* Explain schema changes before applying them.

## Security

* Never expose secrets or credentials.
* Never commit .env, .env.local or other environment files.
* Preserve existing authentication and authorization.

## Testing

* Run relevant tests after changes.
* Check for TypeScript and build errors.
* Explain what was changed and what was tested.

## Permanent project requirements
* 
* \### Neon Free plan (production and development share one project)
* \- 100 CU-hours/month, 1 GB storage, 5 GB transfer/month, autoscale up to 2 CU, compute suspends after 5 min idle.
* \- Never assume the database stays warm or can be upgraded. Design for cold starts.
* 
* \### Priority order for every feature
* 1\. Fast user experience  2. Minimum database operations  3. Low compute and bandwidth
* 4\. Correct, reliable business data (never traded away for fewer queries)  5. Maintainable code
* 
* \### Rules
* \- Frontend: instant feedback on every tap; no full-page reloads or unnecessary router.refresh();
* &#x20; fetch only what the screen needs; paginate large lists; debounce search; optimistic updates only where safe.
* \- Backend: no N+1 queries; combine sequential queries when safe; reuse the session and query results
* &#x20; within a request; return lightweight responses; no unnecessary polling.
* \- Database: use the pooled Neon endpoint; select only needed columns (no SELECT \*); add indexes based
* &#x20; on real query patterns; aggregate in SQL for dashboards; cache only reference data (articles,
* &#x20; vendors) with clear invalidation; never cache orders, inventory or other operational data
* &#x20; without a stated consistency plan.
* \- Measure before optimizing. Separate frontend, backend, database, Neon cold-start and network time.
* &#x20; Do not add Redis, another database or extra services without measured evidence.
* \- Before implementing any feature, state its query count per action, expected response time,
* &#x20; compute impact and data-consistency risks.
* \- Never run migrations, SQL, Neon operations, deployments or pushes unless explicitly asked.


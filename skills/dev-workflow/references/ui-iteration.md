# UI feature iteration

For tasks whose main deliverable is an interface or interaction.

## Explore variations before committing

- For a new surface (page, component, visual style), build 2-3 quick variations
  that differ in a meaningful way (layout, density, interaction model) — not
  cosmetic recolors of one idea.
- Put variations behind a temporary route/flag or a scratch page so they're
  cheap to compare and delete. Don't wire them into real data or navigation yet.
- Present them to the user (screenshots or a URL) and let them pick/combine.
  Delete the losers immediately.

## Iterate with your own eyes

- After every meaningful change, look at the result: take a screenshot via the
  available browser tools and compare it against the intent before asking the
  user to look.
- Check the states that break layouts: empty data, long strings, loading,
  error, narrow viewport, dark mode (if the app has it).
- Watch the browser console while exercising the UI; treat new errors/warnings
  as failures even if the page "looks fine."

## Integrate properly

Once a direction is chosen:

- Move it from scratch/flag into the real component tree, real data, real
  routing. Reuse the project's existing design tokens/components — match the
  codebase's idiom rather than inventing a parallel style.
- Remove the temporary route/flag and all unused variation code.
- Then run the normal `tdd` flow for the behavior (interactions, state), and
  verify visually one last time in the integrated location.

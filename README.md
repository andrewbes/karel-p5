# Karel p5.js Web Prototype

Simple browser prototype of Karel:
- code editor on the left
- Karel world on the right
- `Run`, `Step`, and `Reset` controls

## Run locally

Since this project uses ES modules, open it via a local static server.

Example (from this folder):

```bash
python3 -m http.server 8000
```

Then open: <http://localhost:8000>

## Deploy to GitHub Pages

1. Push the folder to a GitHub repository.
2. In repository settings, enable **Pages** from branch (`main`) and root (or `/docs` depending on your setup).
3. The app works as a static site, no backend required.

## Notes

- This is a minimal MVP interpreter with one command per line:
  - `move()`
  - `turnLeft()`
  - `putBeeper()`
  - `pickBeeper()`
  - `paintCorner("Color")`
- Trailing semicolons are optional (`move()` and `move();` both work).
- You can extend parser support for loops and conditions later.

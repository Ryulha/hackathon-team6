# Forecast MVP workspace

- Preserve provided CSVs, PDFs, README and data specification verbatim.
- Source data, fitted models and row-level outputs stay local; never push or deploy them.
- Limit implementation to demand forecasting and BOM usage estimation. Do not modify other team members' code.
- Team interfaces are proposals: label contract documents `STATUS: PROPOSED — NOT TEAM APPROVED`.
- Forecast origin is start of day in Asia/Seoul; sales on or after the origin are unavailable.
- Split train/validation/test by target date; exclude unavailable menus from targets, preserve active zero-demand days.
- Run `.venv/bin/python -m pytest` and the real-data pipeline before declaring completion.
- Report synthetic-data findings as synthetic-data findings, never real store performance.

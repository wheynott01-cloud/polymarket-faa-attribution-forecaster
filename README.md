# Polymarket FAA Outage Attribution Forecaster

An offline probabilistic quantile forecaster for Polymarket's FAA outage attribution markets, built for the `polymarket-faa-attribution-01` make.fun bounty.

## Overview
This entry forecasts the Yes price of the four Polymarket FAA outage attribution markets minute by minute, 4 hours (240 minutes) ahead, providing five quantile levels (0.05, 0.25, 0.5, 0.75, 0.95) for each minute.

## How to Run
```bash
mkdir -p out
MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

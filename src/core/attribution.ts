/**
 * Who the data belongs to.
 *
 * Terrain tiles are a composite: the elevation under your feet in the Alps came
 * from a different survey than the one under a reader in Otago, and several of
 * those surveys ask to be named. The licences say attribution must "appear in a
 * place that is reasonable to the medium", which for an app means on screen —
 * not only in a file in the repository. So this list is the single source for
 * both the Credits panel and THIRD-PARTY-NOTICES.md.
 *
 * The wording is reproduced from the terrain-tiles project's own attribution
 * document rather than paraphrased, because paraphrasing a licence notice is
 * how you stop satisfying it.
 */

export interface Credit {
  /** Short label for the on-screen list. */
  who: string;
  /** The notice as the provider asks for it. */
  text: string;
  url?: string;
}

/** Elevation. Required attribution for AWS Terrain Tiles / Tilezen terrarium. */
export const TERRAIN_CREDITS: Credit[] = [
  {
    who: 'ArcticDEM',
    text: 'ArcticDEM terrain data DEM(s) were created from DigitalGlobe, Inc., '
      + 'imagery and funded under National Science Foundation awards 1043681, '
      + '1559691, and 1542736.',
  },
  {
    who: 'Geoscience Australia',
    text: 'Australia terrain data © Commonwealth of Australia (Geoscience Australia) 2017.',
  },
  {
    who: 'data.gv.at',
    text: 'Austria terrain data © offene Daten Österreichs – Digitales '
      + 'Geländemodell (DGM) Österreich.',
  },
  {
    who: 'Government of Canada',
    text: 'Canada terrain data contains information licensed under the Open '
      + 'Government Licence – Canada.',
  },
  {
    who: 'Copernicus / EU-DEM',
    text: 'Europe terrain data produced using Copernicus data and information '
      + 'funded by the European Union - EU-DEM layers.',
  },
  {
    who: 'NOAA',
    text: 'Global ETOPO1 terrain data U.S. National Oceanic and Atmospheric Administration.',
  },
  {
    who: 'INEGI',
    text: 'Mexico terrain data source: INEGI, Continental relief, 2016.',
  },
  {
    who: 'Land Information New Zealand',
    text: 'New Zealand terrain data Copyright 2011 Crown copyright (c) Land '
      + 'Information New Zealand and the New Zealand Government (All rights reserved).',
  },
  {
    who: 'Kartverket',
    text: 'Norway terrain data © Kartverket.',
  },
  {
    who: 'Environment Agency',
    text: 'United Kingdom terrain data © Environment Agency copyright and/or '
      + 'database right 2015. All rights reserved.',
  },
  {
    who: 'U.S. Geological Survey',
    text: 'United States 3DEP (formerly NED) and global GMTED2010 and SRTM '
      + 'terrain data courtesy of the U.S. Geological Survey.',
  },
];

/** Everything else the app leans on. */
export const OTHER_CREDITS: Credit[] = [
  {
    who: 'OpenStreetMap contributors',
    text: 'Summit names and positions © OpenStreetMap contributors, available '
      + 'under the Open Database Licence (ODbL).',
    url: 'https://www.openstreetmap.org/copyright',
  },
  {
    who: 'AWS Open Data / Tilezen',
    text: 'Elevation tiles served from the AWS Terrain Tiles public dataset, '
      + 'in the Tilezen "terrarium" encoding.',
    url: 'https://registry.opendata.aws/terrain-tiles/',
  },
  {
    who: 'NOAA NCEI and the British Geological Survey',
    text: 'Magnetic declination from the World Magnetic Model 2025.',
    url: 'https://www.ncei.noaa.gov/products/world-magnetic-model',
  },
  {
    who: 'Babylon.js',
    text: 'Rendering by Babylon.js, Apache-2.0.',
    url: 'https://www.babylonjs.com',
  },
];

/** One line suitable for a photo caption or an export footer. */
export const SHORT_CREDIT =
  'Terrain: AWS Terrain Tiles (USGS SRTM/3DEP, Copernicus EU-DEM and others). '
  + 'Summits: © OpenStreetMap contributors, ODbL.';

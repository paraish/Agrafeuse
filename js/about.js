// Who made Agrafeuse and how to cite it. Keep in sync with CITATION.cff.
// Copies and modified versions must keep this attribution and the "How to cite"
// notice in the app's footer (GNU AGPL v3, section 7(b); see NOTICE).

export const ABOUT = {
  name: 'Agrafeuse',
  version: '0.1.0',
  author: 'Paraish S. Misra',
  year: 2026,
  title: 'Agrafeuse: An open source application for quick quantitative data analysis and visualization',
  url: 'https://github.com/paraish/Agrafeuse',
  site: 'https://paraish.github.io/Agrafeuse/',
  lab: 'https://misralab.ca/',
  license: 'https://www.gnu.org/licenses/agpl-3.0.html',
  doi: '10.5281/zenodo.23693687', // Zenodo, for version 0.1.0
};

export const DOI_URL = `https://doi.org/${ABOUT.doi}`;

export const CITATION = `Misra, Paraish S. (${ABOUT.year}). ${ABOUT.title} (Version ${ABOUT.version}) [Computer software]. Zenodo. ${DOI_URL}`;

export const AI_CREDIT = `Developed by ${ABOUT.author} with AI-assisted programming (Claude, Anthropic).`;

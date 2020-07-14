import {
  all, call, put, select, takeEvery,race, take, delay,
} from 'redux-saga/effects';
import ActionTypes from 'mirador/dist/es/src/state/actions/action-types.js';
import { receiveSearch } from 'mirador/dist/es/src/state/actions';
import { getCanvases, getWindowIds } from 'mirador/dist/es/src/state/selectors';
import { requestText, PluginActionTypes } from 'mirador-textoverlay/es/state/actions.js';
import { getTexts } from 'mirador-textoverlay/es/state/selectors.js';
import lunr from "lunr";

/** Checks if a given resource points to an ALTO OCR document */
const isAlto = (resource) => resource && (
  resource.format === 'application/xml+alto'
    || (resource.profile && resource.profile.startsWith('http://www.loc.gov/standards/alto/')));

/** Checks if a given resource points to an hOCR document */
const isHocr = (resource) => resource && (
  resource.format === 'text/vnd.hocr+html'
    || (resource.profile && (
      resource.profile === 'https://github.com/kba/hocr-spec/blob/master/hocr-spec.md'
      || resource.profile.startsWith('http://kba.cloud/hocr-spec/')
      || resource.profile.startsWith('http://kba.github.io/hocr-spec/'))));

function *getOcrSourcesToFetch(windowId) {
  const canvases = yield select(getCanvases, { windowId });
  const texts = yield select(getTexts);

  return canvases.map(canvas => {
    const { width, height } = canvas.__jsonld;
    const seeAlso = (
      Array.isArray(canvas.__jsonld.seeAlso) ? canvas.__jsonld.seeAlso : [canvas.__jsonld.seeAlso])
      .filter((res) => isAlto(res) || isHocr(res))[0];
    if (seeAlso === undefined) return;

    const ocrSource = seeAlso['@id'];
    const alreadyHasText = texts[canvas.id] && texts[canvas.id].source === ocrSource;
    if (alreadyHasText) return;

    return [canvas.id, ocrSource, { height, width }];
  }).filter(a => a);
}

function *fetchCanvasText(canvasId, ocrSource, { height, width }) {
  yield put(requestText(
    canvasId, ocrSource, { height, width },
  ));
}

function *waitForOcrSources({ windowId }) {
  const ocrSources = yield call(getOcrSourcesToFetch, windowId);
  yield all([
    ...ocrSources.map(source => call(fetchCanvasText, ...source)),
    race([
      all([
        ...ocrSources.map(source => source[1]).map(uri => (
          take(
            ({ type, textUri}) => (
              (type === PluginActionTypes.RECEIVE_TEXT || type === PluginActionTypes.RECEIVE_TEXT_FAILURE)
              && textUri === uri
            )
          )
        ))
      ]),
      delay(30000),
    ])
  ]);
}

const indexes = {};
global.indexes = indexes;

function parseOcr(builder) {
  function tokenizer ({ lines }, metadata) {
    const tokens = [];

    for (const line of lines) {
      for (const word of (line.words || [])) {
        const tokenMetadata = lunr.utils.clone(metadata) || {};
        tokenMetadata.position = {
          x: word.x,
          y: word.y,
          w: word.width,
          h: word.height,
          text: word.text,
        };
        const content = word.text;
        if (content && content.length > 0) {
          const token = lunr.utils.asString(content).toLowerCase();
          tokens.push(new lunr.Token(token, tokenMetadata));
        }
      }
    }

    return tokens;
  }

  // Register the pipeline function so the index can be serialised
  // lunr.Pipeline.registerFunction(tokenizer, 'parseAltoTokenizer')

  // Add the pipeline function to both the indexing pipeline and the
  // searching pipeline
  builder.tokenizer = tokenizer;
}

function *processLunrIndex({ windowId }) {
  const canvases = yield select(getCanvases, { windowId });
  const texts = yield select(getTexts);

  const builder = new lunr.Builder();
  builder.pipeline.add(lunr.trimmer, lunr.stopWordFilter, lunr.stemmer);
  builder.searchPipeline.add(lunr.stemmer);
  builder.ref("canvasId");
  builder.field("text");
  builder.use(parseOcr);
  builder.metadataWhitelist = ["position"];

  canvases.forEach(canvas => {
    const text = texts[canvas.id] && texts[canvas.id].text;
    if (text) builder.add({ canvasId: canvas.id, text })
  });

  indexes[windowId] = builder.build();

  return indexes[windowId];
}

function *handleSearchWithLunr({ companionWindowId, query, windowId }) {
  yield call(waitForOcrSources, { windowId });

  if (!indexes[windowId]) yield call(processLunrIndex, { windowId });

  const results = indexes[windowId].search(query);
  const resources = [];
  results.forEach((canvasHit, canvasIndex) => {
    Object.values(canvasHit.matchData.metadata).forEach(({text}) => {
      text.position.forEach((hit, hitIndex) => {
        resources.push({
          '@id': `local-result-${canvasIndex}-${hitIndex}`,
          '@type': 'oa:Annotation',
          motivation: 'sc:painting',
          on: `${canvasHit.ref}#xywh=${Math.round(hit.x)},${Math.round(hit.y)},${Math.round(hit.w)},${Math.round(hit.h)}`,
          resource: {
            '@type': 'cnt:ContentAsText',
            chars: hit.text,
          }
        });
      });
    })
  });
  const searchJson  = {
    "@context":"http://iiif.io/api/presentation/3/context.json",
    "@id": `local-search-${query}`,
    "@type":"sc:AnnotationList",
    "resources": resources,
    "hits": resources.map(({ '@id': id }) => (
      {
        "@type": "search:Hit",
        "annotations": [
          id
        ],
      }
    )),
  };
  yield put(receiveSearch(windowId, companionWindowId, windowId, searchJson))
}

// function *updateLunrIndex(action) {
//   const windowIds = yield select(getWindowIds);
//
//   for (const windowId of windowIds) {
//     const canvases = yield select(getCanvases, { windowId });
//
//     if (canvases.some(c => c.id === action.targetId)) {
//       yield call(processLunrIndex, { windowId });
//     }
//   }
// }

function* searchSaga() {
  yield all([
    takeEvery(ActionTypes.REQUEST_SEARCH, handleSearchWithLunr),
  ]);
}

export default [
  {
    component: () => {},
    saga: searchSaga
  }
];

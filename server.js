const express = require('express');
const cors = require('cors');
const { fetchDictionaryWord } = require('cambridge-dictionary-api');
const wr = require('wordreference-api');
require('dotenv').config();

const app = express();
app.use(cors());

app.get('/api/lookup', async (req, res) => {
  const word = req.query.word;
  if (!word) return res.status(400).json({ error: 'No word provided' });

  try {
    const result = await fetchDictionaryWord(word);
    const firstDef = result.definitions[0];

    res.json({
      word: result.word,
      definition: firstDef.definition,
      examples: firstDef.examples,
      partOfSpeech: firstDef.partOfSpeech,
      level: firstDef.level,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch word info' });
  }
});

app.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
});
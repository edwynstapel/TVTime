/**
 * DeepSeek AI API integration (OpenAI-compatible).
 * Used for AI-powered show research (next season status, rumors, etc.).
 *
 * Default API key provided — can be changed in Settings.
 */

var DEEPSEEK_DEFAULT_KEY = '';

var Anthropic = {
    _key: null,

    getKey() {
        if (this._key) return this._key;
        // Only use localStorage, no default key
        this._key = localStorage.getItem('tvtime_deepseek_key') || '';
        return this._key;
    },

    setKey(key) {
        this._key = key;
        localStorage.setItem('tvtime_deepseek_key', key);
    },

    /**
     * Ask DeepSeek about a show's next season status.
     * Returns the full text response.
     */
    async askAboutShow(showData, seasons, lastEpisodes) {
        var key = this.getKey();
        if (!key) throw new Error('No DeepSeek API key configured. Add it in Settings.');

        var systemPrompt = [
            'You are a TV industry research assistant. A user wants to know about the next season of a TV show.',
            'Analyze the provided show data and your knowledge to answer:',
            '- Is the next season confirmed/announced?',
            '- Is it currently filming or in pre/post-production?',
            '- What is the potential release date or window?',
            '- Any relevant rumors, news, or production updates from the web?',
            '',
            'Be thorough but concise. Use bullet points. If you have no information beyond what was provided, say so honestly. Include any web-search-worthy details you know from your training data. Include specific dates and sources when possible.',
            'Format your response in Markdown with clear sections: **Status**, **Filming**, **Release Date**, **Rumors & News**.'
        ].join('\n');

        var userMessage = [
            '## Show: ' + showData.name,
            '',
            '**Current TMDB Status:** ' + (showData.status || 'Unknown'),
            '**In Production:** ' + (showData.in_production ? 'Yes' : 'No'),
            '**First Aired:** ' + (showData.first_air_date || 'N/A'),
            '**Number of Seasons:** ' + (showData.number_of_seasons || 'N/A'),
            '**Number of Episodes:** ' + (showData.number_of_episodes || 'N/A'),
            '**Networks:** ' + ((showData.networks || []).map(function(n) { return n.name; }).join(', ') || 'N/A'),
            '**Genres:** ' + ((showData.genres || []).map(function(g) { return g.name; }).join(', ') || 'N/A'),
            '**Last Episode to Air:** ' + (showData.last_episode_to_air ? showData.last_episode_to_air.name + ' (S' + showData.last_episode_to_air.season_number + 'E' + showData.last_episode_to_air.episode_number + ') - ' + showData.last_episode_to_air.air_date : 'N/A'),
            '**Next Episode to Air:** ' + (showData.next_episode_to_air ? showData.next_episode_to_air.name + ' (S' + showData.next_episode_to_air.season_number + 'E' + showData.next_episode_to_air.episode_number + ') - ' + showData.next_episode_to_air.air_date : 'N/A'),
            '',
            '**Seasons:**',
        ].join('\n');

        seasons.forEach(function(s) {
            userMessage += '\n- Season ' + s.season_number + ': ' + s.episode_count + ' episodes, aired ' + (s.air_date || 'TBA');
        });

        if (lastEpisodes && lastEpisodes.length > 0) {
            userMessage += '\n\n**Latest Season Episodes:**';
            lastEpisodes.forEach(function(ep) {
                userMessage += '\n- S' + ep.season_number + 'E' + ep.episode_number + ': ' + (ep.name || 'Untitled') + ' - ' + (ep.air_date || 'TBA');
            });
        }

        userMessage += '\n\nWhat can you tell me about the next season of ' + showData.name + '? Include any web-sourced information, rumors, and production updates.';

        var response = await fetch('https://api.deepseek.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': 'Bearer ' + key,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'deepseek-chat',
                max_tokens: 2000,
                temperature: 0.7,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userMessage }
                ]
            })
        });

        if (!response.ok) {
            var errText = '';
            try { var errData = await response.json(); errText = errData.error ? errData.error.message : ''; } catch(e) {}
            throw new Error('DeepSeek API error ' + response.status + (errText ? ': ' + errText : ''));
        }

        var data = await response.json();
        return data.choices[0].message.content;
    }
};

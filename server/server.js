const express = require("express");
const path = require("path");
const bodyParser = require("body-parser");
const session = require("express-session");
const bcrypt = require("bcrypt");
const config = require("./config.js");
const movieModel = require("./movie-model.js");
const userModel = require("./user-model.js");

const app = express();

// Parse JSON bodies
app.use(bodyParser.json());

// Session middleware
app.use(session({
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false }
}));

// Serve static content in directory 'files'
app.use(express.static(path.join(__dirname, "files")));

// Middleware for protected endpoints
function requireLogin(req, res, next) {
    if (req.session && req.session.user) {
        next();
    } else {
        res.sendStatus(401);
    }
}

app.post("/login", function (req, res) {
    console.log("LOGIN BODY:", req.body);

    const { username, password } = req.body;
    const user = userModel[username];

    console.log("USERNAME:", username);
    console.log("USER FOUND:", user);
    console.log("PASSWORD MATCH:", user && bcrypt.compareSync(password, user.password));

    if (user && bcrypt.compareSync(password, user.password)) {
        req.session.user = {
            username,
            firstName: user.firstName,
            lastName: user.lastName,
            loginTime: new Date().toISOString(),
        };
        res.send(req.session.user);
    } else {
        res.sendStatus(401);
    }
});

app.get("/logout", function (req, res) {
    req.session.destroy(function (err) {
        if (err) {
            res.sendStatus(500);
        } else {
            res.sendStatus(200);
        }
    });
});

app.get("/session", function (req, res) {
    if (req.session.user) {
        res.send(req.session.user);
    } else {
        res.status(401).json(null);
    }
});

app.get("/movies", requireLogin, function (req, res) {
    const username = req.session.user.username;
    let movies = Object.values(movieModel.getUserMovies(username));

    const queriedGenre = req.query.genre;

    if (queriedGenre) {
        movies = movies.filter((movie) => movie.Genres.indexOf(queriedGenre) >= 0);
    }

    res.send(movies);
});

app.get("/movies/:imdbID", requireLogin, function (req, res) {
    const username = req.session.user.username;
    const id = req.params.imdbID;
    const movie = movieModel.getUserMovie(username, id);

    if (movie) {
        res.send(movie);
    } else {
        res.sendStatus(404);
    }
});

app.put("/movies/:imdbID", requireLogin, function (req, res) {
    const username = req.session.user.username;
    const imdbID = req.params.imdbID;
    const exists = movieModel.getUserMovie(username, imdbID) !== undefined;

    if (!exists) {
        // Task 2.3 will be implemented later
        const url = `http://www.omdbapi.com/?i=${encodeURIComponent(imdbID)}&apikey=${config.omdbApiKey}`;

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), config.omdbTimeoutMs);

        fetch(url, { signal: controller.signal })
            .then(apiRes => {
                clearTimeout(timeoutId);

                if (!apiRes.ok) {
                    return res.sendStatus(apiRes.status);
                }

                return apiRes.json();
            })
            .then(omdbMovie => {
                if (!omdbMovie || omdbMovie.Response === "False") {
                    return res.sendStatus(404);
                }

                const movie = {
                    imdbID: omdbMovie.imdbID,
                    Title: omdbMovie.Title,
                    Released: omdbMovie.Released,
                    Runtime: parseInt(omdbMovie.Runtime),
                    Genres: omdbMovie.Genre.split(",").map(item => item.trim()),
                    Directors: omdbMovie.Director.split(",").map(item => item.trim()),
                    Writers: omdbMovie.Writer.split(",").map(item => item.trim()),
                    Actors: omdbMovie.Actors.split(",").map(item => item.trim()),
                    Plot: omdbMovie.Plot,
                    Poster: omdbMovie.Poster,
                    Metascore: Number(omdbMovie.Metascore),
                    imdbRating: Number(omdbMovie.imdbRating)
                };

                movieModel.setUserMovie(username, imdbID, movie);
                res.status(201).send(movie);
            })
            .catch(err => {
                clearTimeout(timeoutId);

                if (err.name === "AbortError") {
                    console.error("OMDb API request timeout");
                    return res.sendStatus(504);
                }

                console.error("OMDb API error:", err);
                res.sendStatus(500);
            });
    } else {
        movieModel.setUserMovie(username, imdbID, req.body);
        res.sendStatus(200);
    }
});

app.delete("/movies/:imdbID", requireLogin, function (req, res) {
    const username = req.session.user.username;
    const id = req.params.imdbID;

    if (movieModel.deleteUserMovie(username, id)) {
        res.sendStatus(200);
    } else {
        res.sendStatus(404);
    }
});

app.get("/genres", requireLogin, function (req, res) {
    const username = req.session.user.username;
    const genres = movieModel.getGenres(username);

    genres.sort();
    res.send(genres);
});

app.get("/search", requireLogin, function (req, res) {
    const username = req.session.user.username;
    const query = req.query.query;

    if (!query) {
        return res.sendStatus(400);
    }

    const url = `http://www.omdbapi.com/?s=${encodeURIComponent(query)}&apikey=${config.omdbApiKey}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.omdbTimeoutMs);

    fetch(url, { signal: controller.signal })
        .then(apiRes => {
            clearTimeout(timeoutId);

            if (!apiRes.ok) {
                return res.sendStatus(apiRes.status);
            }

            return apiRes.text().then(data => {
                let response;

                try {
                    response = JSON.parse(data);
                } catch (parseError) {
                    console.error("Failed to parse OMDb response:", parseError);
                    return res.sendStatus(500);
                }

                if (response.Response === "True") {
                    const results = response.Search
                        .filter(movie => !movieModel.hasUserMovie(username, movie.imdbID))
                        .map(movie => ({
                            Title: movie.Title,
                            imdbID: movie.imdbID,
                            Year: isNaN(movie.Year) ? null : parseInt(movie.Year)
                        }));

                    res.send(results);
                } else {
                    res.send([]);
                }
            });
        })
        .catch((err) => {
            clearTimeout(timeoutId);

            if (err.name === "AbortError") {
                console.error("OMDb API request timeout");
                return res.sendStatus(504);
            }

            console.error("OMDb API error:", err);
            res.sendStatus(500);
        });
});

app.listen(config.port);

console.log(`Server now listening on http://localhost:${config.port}/`);
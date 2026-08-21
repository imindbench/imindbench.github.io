from pathlib import Path


SITE_ROOT = Path(__file__).resolve().parents[1]


def test_homepage_links_to_public_resources_and_leaderboard():
    source = (SITE_ROOT / "index.html").read_text()

    assert 'href="https://arxiv.org/"' in source
    assert 'href="https://github.com/imindbench/iMINDBench"' in source
    assert 'href="leaderboard/"' in source
    assert 'class="fas fa-file-pdf"' in source
    assert 'aria-label="Open the iMINDBench leaderboard"' in source


def test_homepage_introduces_the_benchmark_and_approved_figures():
    source = (SITE_ROOT / "index.html").read_text()

    assert "iEEG Multi-Institution Neural Decoding Benchmark" in source
    assert "preprocessor-structured benchmark" in source
    assert "benchmark_overview.png" in source
    assert "dataset_summary.png" in source
    assert source.count("<figure") == 2
    assert source.count("<figcaption") == 2
    assert (SITE_ROOT / "assets" / "images" / "benchmark_overview.png").is_file()
    assert (SITE_ROOT / "assets" / "images" / "dataset_summary.png").is_file()


def test_homepage_has_responsive_and_accessibility_metadata():
    source = (SITE_ROOT / "index.html").read_text()

    assert 'name="viewport"' in source
    assert 'name="description"' in source
    assert '<main id="main-content">' in source
    assert 'href="#main-content"' in source
    assert (SITE_ROOT / "style.css").is_file()


def test_homepage_links_each_dataset_to_its_paper():
    source = (SITE_ROOT / "index.html").read_text()

    assert 'href="https://arxiv.org/abs/2509.21671"' in source
    assert "aefa2385b3f33abf1526ae4e2c208cd9" in source
    assert 'href="https://doi.org/10.1038/s41597-024-03029-1"' in source
    assert 'href="https://doi.org/10.1038/s41597-022-01173-0"' in source


def test_homepage_links_dataset_package():
    source = (SITE_ROOT / "index.html").read_text()

    assert 'href="https://github.com/neuro-galaxy/torch_brain/"' in source


def test_leaderboard_title_links_back_to_homepage():
    source = (SITE_ROOT / "leaderboard" / "index.html").read_text()

    assert '<a class="site-home-link" href="/"' in source
    assert 'aria-label="Return to the iMINDBench homepage"' in source
    assert source.index('<a class="site-home-link"') < source.index("<h1")
    assert source.index("</p>") < source.index("</a>")

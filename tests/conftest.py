import json

import pytest

from forecast.data import load_data
from forecast.features import FeatureBuilder
from forecast.model import DemandModel


@pytest.fixture(scope="session")
def data():
    return load_data()


@pytest.fixture(scope="session")
def builder(data):
    return FeatureBuilder(data)


@pytest.fixture(scope="session")
def fitted_model(builder, tmp_path_factory):
    # Actual provided data, short training for behavioral tests; full training runs in CLI.
    train = builder.supervised(origin_start="2026-05-01", origin_end="2026-05-05")
    model = DemandModel.fit(train, iterations=20)
    directory = tmp_path_factory.mktemp("model")
    model.save(directory / "catboost")
    (directory / "selection.json").write_text(json.dumps({"selected_model": "catboost"}))
    return model, directory

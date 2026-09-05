CLASS zcl_fixture_nodisplay DEFINITION PUBLIC.
  PUBLIC SECTION.
    INTERFACES z2ui5_if_app.
    DATA name TYPE string.
ENDCLASS.

CLASS zcl_fixture_nodisplay IMPLEMENTATION.
  METHOD z2ui5_if_app~main.

    " builds a view and never hands it to the client - renders nothing,
    " and nothing anywhere reports an error
    DATA(view) = z2ui5_cl_ui5_view_builder=>factory( ).
    view->ele( n = `View` ns = `mvc`
        )->a( n = `xmlns`     v = `sap.m`
        )->a( n = `xmlns:mvc` v = `sap.ui.core.mvc`
        )->ele( `Page`
          )->tag( `Text`
            )->a( n = `text` v = client->_bind( name ) ).

  ENDMETHOD.
ENDCLASS.
